import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { formatTime, formatSize } from '../lib/time'
import { EmptyState } from './EmptyState'
import { UnappliedFilterNotice } from './FilterNotice'
import { parseQuery, type ParseOutcome } from '../../../core/query/contract'
import { AlignLeft } from 'lucide-react'
import { toEventFilter, useSharedFilter } from '../lib/FilterContext'

/**
 * v0.11.2 (design note T5): the Timeline read vertically.
 *
 * The Timeline is a forensic view — lanes, clusters, causality, integrity
 * badges. It answers "when did this happen, and what did it cause". It does
 * not answer the question an operator actually asks when writing up an
 * engagement, which is "what did I type and what came back", in order, as
 * prose. Reconstructing that meant clicking dots one at a time.
 *
 * This is the same event store, the same redaction masking and the same
 * filters, laid out as a scrollable narrative: one exchange per block, input
 * above output. Nothing here is a new source of truth — it is a second
 * reading of the rows the chain already holds.
 *
 * Deliberately NOT here: any interpretation. No severity inference from
 * output, no diffing, no assessment. It shows what happened; judging it is
 * downstream work (docs/README.md: "not RedLog's job").
 */

interface Ev {
  id: string
  timestamp: number
  createdAt?: number
  agentType: string
  operatorId: string
  targetId?: string | null
  data?: Record<string, unknown>
}

function toolPairKey(e: Ev): string | null {
  if (e.agentType !== 'agent') return null
  const d = e.data ?? {}
  if ((d.subtype !== 'tool_call' && d.subtype !== 'tool_result' && d.subtype !== 'tool_interrupted') ||
      typeof d.session_id !== 'string' || typeof d.tool_use_id !== 'string') return null
  return `${d.session_id}:${d.tool_use_id}`
}

async function completeToolPairs(events: Ev[]): Promise<Ev[]> {
  const seenKinds = new Map<string, Set<unknown>>()
  const keyParts = new Map<string, { sessionId: string; toolUseId: string }>()
  for (const event of events) {
    const key = toolPairKey(event)
    if (!key) continue
    const d = event.data ?? {}
    const kinds = seenKinds.get(key) ?? new Set()
    kinds.add(d.subtype)
    seenKinds.set(key, kinds)
    keyParts.set(key, { sessionId: String(d.session_id), toolUseId: String(d.tool_use_id) })
  }
  const missing = [...seenKinds]
    .filter(([, kinds]) => !(kinds.has('tool_call') && (kinds.has('tool_result') || kinds.has('tool_interrupted'))))
    .map(([key]) => keyParts.get(key)!)
  if (missing.length === 0) return events
  const counterparts = await window.redlog.events.toolCounterparts(missing) as Ev[]
  const byId = new Map(events.map((event) => [event.id, event]))
  for (const event of counterparts) byId.set(event.id, event)
  return [...byId.values()]
}

type Kind = 'shell' | 'agent-turn' | 'agent-tool' | 'http' | 'marker' | 'loot' | 'other'

interface Block {
  id: string
  ts: number
  kind: Kind
  actor: string
  /** the operator's / agent's side of the exchange */
  input: string
  /** what came back, when we have it */
  output?: string
  outputBytes?: number
  /** why there is no output, when there isn't one */
  outputNote?: string
  meta?: string
  events: Ev[]
}

const MAX_INLINE = 4096

const TRANSCRIPT_BUCKETS: Array<{ agentType: string; limit: number }> = [
  { agentType: 'agent', limit: 800 },
  { agentType: 'shell', limit: 400 },
  { agentType: 'scanner', limit: 300 },
  { agentType: 'system', limit: 200 },
  { agentType: 'marker', limit: 100 },
  { agentType: 'loot', limit: 100 },
  { agentType: 'pivot', limit: 100 },
]

/** Which session a bare tool-use condition was resolved within, and which were not. */
interface ToolSessionInfo {
  toolUseId: string
  sessionId: string
  otherSessionIds: string[]
}

interface BucketPageState {
  nextCursor: string | null
  hasMore: boolean
}

const fmtBytes = formatSize

const KIND_COLOR: Record<Kind, string> = {
  shell: '#22c55e',
  'agent-turn': '#84cc16',
  'agent-tool': '#a3a3a3',
  http: '#8b5cf6',
  marker: '#ef4444',
  loot: '#f97316',
  other: '#52525b'
}

/**
 * Fold the event stream into exchanges.
 *
 * The pairing rules mirror what the Timeline already knows: shell
 * command_start/command_end share (pid, command); agent tool_call/tool_result
 * share tool_use_id; HTTP request/response share flow_id. Where a pair is
 * incomplete — the command is still running, the response never came — the
 * block renders with the half that exists and says so.
 */
function buildBlocks(events: Ev[], names: Record<string, string>): Block[] {
  const out: Block[] = []
  const pendingTool = new Map<string, Block>()
  const pendingHttp = new Map<string, Block>()
  const actorOf = (e: Ev): string => names[e.operatorId] ?? e.operatorId

  for (const e of events) {
    const d = e.data ?? {}
    const sub = String(d.subtype ?? '')

    if (e.agentType === 'shell' && sub === 'session_output') {
      const output = String(d.stdout ?? '')
      out.push({ id: e.id, ts: e.timestamp, kind: 'shell', actor: actorOf(e),
        input: `Session ${String(d.terminalId ?? '')} · #${String(d.sequence ?? '')}`,
        output, outputBytes: output.length, meta: 'PTY · stdout/stderr merged', events: [e] })
      continue
    }

    if (e.agentType === 'shell' && sub === 'command_end') {
      const io = d.io as { len?: number; unbracketed?: boolean } | undefined
      const inlineOut = [d.stdout, d.stderr].filter((x) => typeof x === 'string').join('')
      const exitRaw = d.exit_code
      const exitKnown = exitRaw != null
      const exit = exitKnown ? Number(exitRaw) : null
      let outputNote: string | undefined
      let output: string | undefined
      let outputBytes: number | undefined
      if (inlineOut) { output = inlineOut; outputBytes = inlineOut.length }
      else if (io && typeof io.len === 'number' && !io.unbracketed && io.len > 0) {
        outputNote = 'recorded'; outputBytes = io.len
      } else if (d.source === 'builtin-terminal') outputNote = 'unbracketed'
      else outputNote = 'uncaptured'
      out.push({
        id: e.id, ts: e.timestamp, kind: 'shell', actor: actorOf(e),
        input: `$ ${String(d.command ?? '')}`,
        output, outputBytes, outputNote,
        meta: `${exitKnown ? `exit ${exit}` : 'exit unknown'}${d.duration_sec != null ? ` · ${d.duration_sec}s` : ''}`,
        events: [e]
      })
      continue
    }

    if (e.agentType === 'agent') {
      if (sub === 'user_message' || sub === 'assistant_message' || sub === 'thinking') {
        const body = typeof d.full === 'string' ? (d.full as string) : String(d.preview ?? '')
        if (!body) continue
        out.push({
          id: e.id, ts: e.timestamp, kind: 'agent-turn',
          actor: `${d.agent ?? 'agent'} · ${sub.replace('_message', '')}`,
          input: body,
          meta: d.model ? String(d.model) : undefined,
          events: [e]
        })
        continue
      }
      if (sub === 'tool_call') {
        const b: Block = {
          id: e.id, ts: e.timestamp, kind: 'agent-tool',
          actor: `${d.agent ?? 'agent'} · ${d.tool_name ?? 'tool'}`,
          input: safeJson(d.tool_input),
          outputNote: 'unpaired',
          events: [e]
        }
        if (typeof d.tool_use_id === 'string') {
          const tk = `${d.session_id ?? ''}:${d.tool_use_id}`
          pendingTool.set(tk, b)
        }
        out.push(b)
        continue
      }
      if (sub === 'tool_interrupted') {
        const tk = typeof d.tool_use_id === 'string' ? `${d.session_id ?? ''}:${d.tool_use_id}` : null
        const b = tk ? pendingTool.get(tk) : undefined
        if (b) {
          b.outputNote = 'interrupted'
          b.events.push(e)
          pendingTool.delete(tk!)
        } else {
          out.push({
            id: e.id, ts: e.timestamp, kind: 'agent-tool', actor: String(d.agent ?? 'agent'),
            input: '(tool interrupted)', outputNote: 'interrupted', events: [e]
          })
        }
        continue
      }
      if (sub === 'tool_result') {
        const body = typeof d.output === 'string' ? (d.output as string) : ''
        const tk = typeof d.tool_use_id === 'string' ? `${d.session_id ?? ''}:${d.tool_use_id}` : null
        const b = tk ? pendingTool.get(tk) : undefined
        if (b) {
          b.output = body
          b.outputBytes = typeof d.output_length === 'number' ? (d.output_length as number) : body.length
          b.outputNote = undefined
          b.events.push(e)
          pendingTool.delete(tk!)
        } else {
          out.push({
            id: e.id, ts: e.timestamp, kind: 'agent-tool', actor: String(d.agent ?? 'agent'),
            input: '(tool result without a matching call)', output: body, events: [e]
          })
        }
        continue
      }
      continue
    }

    if (e.agentType === 'scanner') {
      const flow = typeof d.flow_id === 'string' ? (d.flow_id as string) : null
      if (sub === 'http_request_start') {
        const b: Block = {
          id: e.id, ts: e.timestamp, kind: 'http', actor: actorOf(e),
          input: `${d.method ?? 'GET'} ${d.url ?? ''}`,
          outputNote: 'pending',
          events: [e]
        }
        if (flow) pendingHttp.set(flow, b)
        out.push(b)
        continue
      }
      if (sub === 'http_response') {
        const b = flow ? pendingHttp.get(flow) : undefined
        const preview = typeof d.response_preview === 'string' ? (d.response_preview as string) : ''
        const len = typeof d.content_length === 'number' ? (d.content_length as number) : undefined
        if (b) {
          b.output = preview || undefined
          b.outputBytes = len
          b.outputNote = preview ? undefined : 'uncaptured'
          b.meta = `${d.status}${d.duration_ms != null ? ` · ${d.duration_ms}ms` : ''}`
          b.events.push(e)
          if (flow) pendingHttp.delete(flow)
        } else {
          out.push({
            id: e.id, ts: e.timestamp, kind: 'http', actor: actorOf(e),
            input: `${d.method ?? ''} ${d.url ?? ''}`, output: preview || undefined,
            outputBytes: len, meta: String(d.status ?? ''), events: [e]
          })
        }
        continue
      }
      continue
    }

    if (e.agentType === 'marker') {
      // A correction is not a turn in the transcript. It carries `title` under
      // the marker's own name, so an unguarded row would read '⚑ undefined' for
      // a severity-only amendment; and even a title amendment would appear as a
      // second finding beside the one it corrects. The transcript reads the
      // conversation, not the audit of it — the Timeline Inspector is where
      // amendments are read.
      if (d.subtype === 'amended' && typeof d.markerId === 'string') continue
      out.push({
        id: e.id, ts: e.timestamp, kind: 'marker', actor: actorOf(e),
        input: `⚑ ${d.title ?? ''}`, output: typeof d.notes === 'string' && d.notes ? (d.notes as string) : undefined,
        meta: String(d.severity ?? ''), events: [e]
      })
      continue
    }

    if (e.agentType === 'loot') {
      const matches = Array.isArray(d.matches) ? (d.matches as Array<Record<string, unknown>>) : []
      out.push({
        id: e.id, ts: e.timestamp, kind: 'loot', actor: actorOf(e),
        input: `◆ ${matches.map((m) => m.type).join(', ') || 'loot'}`,
        meta: `${matches.length} match${matches.length === 1 ? '' : 'es'}`,
        events: [e]
      })
    }
  }
  return out
}

function safeJson(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

export default function TranscriptView({ onOpenInTimeline }: {
  onOpenInTimeline?: (id: string, ts: number) => void
}): JSX.Element {
  const { t } = useI18n()
  const { filter: sharedFilter } = useSharedFilter()
  const [events, setEvents] = useState<Ev[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [kinds, setKinds] = useState<Set<Kind>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [bucketPages, setBucketPages] = useState<Record<string, BucketPageState>>({})
  const [toolSession, setToolSession] = useState<ToolSessionInfo | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const loadSeqRef = useRef(0)

  useEffect(() => {
    const id = setTimeout(() => setActiveQuery(query), 300)
    return () => clearTimeout(id)
  }, [query])

  // Spec 017: the parse happens here, so the surface can show how it read the
  // query and a half-typed condition never becomes a store query at all.
  const parse: ParseOutcome | null = useMemo(
    () => (activeQuery.trim() ? parseQuery(activeQuery) : null),
    [activeQuery]
  )
  const backendQuery = parse?.ok ? parse.parsed : null
  const parseFailed = parse !== null && !parse.ok

  const buckets = useMemo(() => sharedFilter.agentType
    ? TRANSCRIPT_BUCKETS.filter((bucket) => bucket.agentType === sharedFilter.agentType)
    : TRANSCRIPT_BUCKETS, [sharedFilter.agentType])

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setLoadingOlder(false)
    setLoadError(null)
    setEvents([])
    setBucketPages({})
    try {
      // Balanced per-type query so high-volume types (HTTP/scanner) don't
      // crowd out AI conversation and shell events.
      const results = await Promise.all(
        buckets.map(async (bucket) => ({
          bucket,
          page: backendQuery
            ? await window.redlog.events.runQuery({
              parsed: backendQuery,
              filter: { ...toEventFilter(sharedFilter), agentType: bucket.agentType },
              limit: bucket.limit
            })
            : await window.redlog.events.queryPage({
              ...toEventFilter(sharedFilter),
              ...bucket,
            })
        }))
      )
      if (seq !== loadSeqRef.current) return
      const seen = new Set<string>()
      const merged: Ev[] = []
      const pages: Record<string, BucketPageState> = {}
      setToolSession(results.map((r) => (r.page as { toolSession?: ToolSessionInfo }).toolSession).find(Boolean) ?? null)
      for (const { bucket, page } of results) {
        pages[bucket.agentType] = { nextCursor: page.nextCursor, hasMore: page.hasMore }
        for (const e of page.items as Ev[]) {
          if (!seen.has(e.id)) { seen.add(e.id); merged.push(e) }
        }
      }
      const completed = await completeToolPairs(merged)
      if (seq !== loadSeqRef.current) return
      completed.sort((a, b) => a.timestamp - b.timestamp)
      setEvents(completed)
      setBucketPages(pages)
    } catch (error: unknown) {
      if (seq === loadSeqRef.current) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [buckets, backendQuery, sharedFilter.targetId, sharedFilter.timeRange, sharedFilter.inScopeOnly, sharedFilter.hidePersonal])

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return
    const seq = loadSeqRef.current
    const pending = buckets.filter((bucket) => bucketPages[bucket.agentType]?.hasMore && bucketPages[bucket.agentType]?.nextCursor)
    if (pending.length === 0) return
    setLoadingOlder(true)
    setLoadError(null)
    try {
      const results = await Promise.all(pending.map(async (bucket) => ({
        bucket,
        page: backendQuery
          ? await window.redlog.events.runQuery({
            parsed: backendQuery,
            filter: { ...toEventFilter(sharedFilter), agentType: bucket.agentType },
            limit: bucket.limit,
            cursor: bucketPages[bucket.agentType].nextCursor
          })
          : await window.redlog.events.queryPage({
            ...toEventFilter(sharedFilter),
            ...bucket,
            cursor: bucketPages[bucket.agentType].nextCursor,
          })
      })))
      if (seq !== loadSeqRef.current) return
      const merged = new Map(events.map((event) => [event.id, event]))
      for (const { page } of results) for (const event of page.items as Ev[]) merged.set(event.id, event)
      const completed = await completeToolPairs([...merged.values()])
      if (seq !== loadSeqRef.current) return
      setEvents(completed.sort((a, b) => a.timestamp - b.timestamp))
      setBucketPages((current) => {
        const next = { ...current }
        for (const { bucket, page } of results) {
          next[bucket.agentType] = { nextCursor: page.nextCursor, hasMore: page.hasMore }
        }
        return next
      })
    } catch (error: unknown) {
      if (seq === loadSeqRef.current) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingOlder(false)
    }
  }, [bucketPages, buckets, backendQuery, events, loadingOlder, sharedFilter.targetId, sharedFilter.timeRange, sharedFilter.inScopeOnly, sharedFilter.hidePersonal])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void window.redlog.operators.list().then((ops) => {
      const m: Record<string, string> = {}
      for (const o of ops as Array<{ id: string; name: string }>) m[o.id] = o.name
      setNames(m)
    }).catch(() => {})
  }, [])
  useEffect(() => window.redlog.events.onNewBatch(() => { void load() }), [load])

  const blocks = useMemo(() => buildBlocks(events, names), [events, names])
  const hasMore = Object.values(bucketPages).some((page) => page.hasMore)

  const autoExpandedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const toExpand: string[] = []
    for (const b of blocks) {
      if (autoExpandedRef.current.has(b.id)) continue
      autoExpandedRef.current.add(b.id)
      if (b.kind === 'loot') { toExpand.push(b.id); continue }
      if (b.kind === 'shell' && b.meta) {
        const m = b.meta.match(/^exit (\d+)/)
        if (m && m[1] !== '0') toExpand.push(b.id)
      }
    }
    if (toExpand.length > 0) {
      setExpanded((prev) => { const next = new Set(prev); for (const id of toExpand) next.add(id); return next })
    }
  }, [blocks])

  const shown = useMemo(
    // Text is matched by the store now. Filtering again over the rendered
    // block would drop a row whose match lies in a field the block does not
    // show, making the answer depend on the presentation. Kind stays local and
    // is labelled as such.
    () => blocks.filter((b) => !kinds.size || kinds.has(b.kind)),
    [blocks, kinds]
  )

  const toggleKind = (k: Kind): void => setKinds((prev) => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    return next
  })

  // Deliberately NOT folded into the shell's export control (§10). That menu
  // writes files; this writes the clipboard, and the two want different
  // afterwards — a file dialog versus paste straight into the report you are
  // already writing. Collapsing it would have made the count tidier and the
  // action worse.
  const copyAsMarkdown = useCallback(async () => {
    // The one report-adjacent thing RedLog can offer without becoming a
    // reporting tool: a verbatim transcript, not an assessment.
    const lines: string[] = ['# RedLog transcript', '']
    if (hasMore) lines.push(`> ${t('transcript.partialMarkdown')}`, '')
    for (const b of shown) {
      lines.push(`## ${new Date(b.ts).toISOString()} — ${b.actor}${b.meta ? ` (${b.meta})` : ''}`, '')
      lines.push('```', b.input, '```', '')
      if (b.output) {
        const truncated = b.output.length > MAX_INLINE
        lines.push('```', b.output.slice(0, MAX_INLINE), '```')
        if (truncated) lines.push(`_[truncated — ${fmtBytes(b.output.length)} total]_`)
        lines.push('')
      }
      else if (b.outputNote) lines.push(`_${t(`transcript.note.${b.outputNote}`)}_`, '')
    }
    if (await writeClipboard(lines.join('\n'))) {
      toast(t('transcript.copied'), 'success')
    } else {
      toast(t('transcript.copyFailed'), {
        type: 'error',
        why: t('transcript.copyFailedWhy')
      })
    }
  }, [hasMore, shown, t])

  const KINDS: Kind[] = ['shell', 'agent-turn', 'agent-tool', 'http', 'marker', 'loot']

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-redlog-border/60 shrink-0">
        <h1 className="text-sm font-semibold text-redlog-text">{t('transcript.title')}</h1>
        <span className="text-xs text-redlog-text-faint font-mono">{t('transcript.count', { n: shown.length })}</span>
        {!loading && (!loadError || events.length > 0) && (
          <span data-testid="transcript-completeness" className={`text-xs ${hasMore ? 'text-amber-400' : 'text-emerald-500'}`}>
            {t(backendQuery
              ? (hasMore ? 'transcript.querySubset' : 'transcript.queryComplete')
              : (hasMore ? 'transcript.recentSubset' : 'transcript.complete'))}
          </span>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('transcript.filter')}
          className="ml-2 flex-1 max-w-md bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text placeholder-redlog-text-faint focus:outline-none focus:border-redlog-border"
        />
        {parse?.ok && parse.parsed.tokens.length > 0 && (
          <span data-testid="transcript-query-parse" className="flex items-center gap-1 text-xs">
            <span className="text-redlog-text-faint">{t('transcript.queryReadAs')}</span>
            {parse.parsed.tokens.map((tok, i) => (
              <span
                key={i}
                title={t(tok.read === 'condition' ? 'transcript.queryTokenCondition' : 'transcript.queryTokenText')}
                className={`font-mono px-1 py-0.5 rounded border ${
                  tok.read === 'condition'
                    ? 'text-indigo-300 border-indigo-500/40 bg-indigo-500/10'
                    : 'text-redlog-text-dim border-redlog-border bg-redlog-surface'
                }`}
              >{tok.raw}</span>
            ))}
          </span>
        )}
        <div className="flex gap-1">
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors ${
                kinds.size === 0 || kinds.has(k)
                  ? 'text-redlog-text border-redlog-border bg-redlog-elevated/60'
                  : 'text-redlog-text-faint border-redlog-border hover:text-redlog-text-dim'
              }`}
              style={kinds.has(k) ? { color: KIND_COLOR[k], borderColor: `${KIND_COLOR[k]}66` } : undefined}
            >
              {t(`transcript.kind.${k}`)}
            </button>
          ))}
        </div>
        <button
          onClick={() => void copyAsMarkdown()}
          className="text-xs px-2 py-1 rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover transition-colors shrink-0"
        >
          {t('transcript.copyMd')}
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {/* Unparsable is its own state. It is not a failure — nothing was
            asked — and it is emphatically not an empty result, which would
            invite reading a typo as proof the evidence is absent. */}
        {parseFailed && !parse.ok && (
          <div data-testid="transcript-query-unparsable" role="status" className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <div className="font-medium">{t('transcript.queryUnparsable')}</div>
            <div className="mt-1 text-redlog-text-dim">
              {t(`transcript.queryUnparsable.${parse.reason}`, { token: parse.token })}
            </div>
          </div>
        )}
        {toolSession && (
          <div data-testid="transcript-tool-session" role="status" className="rounded border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200">
            <div>{t('transcript.queryToolSession', { tool: toolSession.toolUseId, session: toolSession.sessionId })}</div>
            {toolSession.otherSessionIds.length > 0 && (
              <div className="mt-1 text-redlog-text-dim">
                {t('transcript.queryToolSessionOthers', { count: toolSession.otherSessionIds.length })}
              </div>
            )}
          </div>
        )}
        {/* The limit of what a term can reach, stated where the term is used.
            Output the hook never captured inline lives in a recording, so an
            unmatched term is not evidence the output never held it. */}
        {backendQuery && backendQuery.text !== '' && (
          <p data-testid="transcript-query-coverage" className="text-xs text-redlog-text-faint">
            {t('transcript.queryCoverage')}
          </p>
        )}
        {kinds.size > 0 && (
          <p data-testid="transcript-kind-local" className="text-xs text-amber-300">
            {t('transcript.kindLoadedOnly')}
          </p>
        )}
        {loading && <p className="text-xs text-redlog-text-faint">{t('transcript.loading')}</p>}
        {!loading && loadError && (
          <div data-testid="transcript-load-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            <div>{t(events.length > 0 ? 'transcript.loadOlderFailed' : 'transcript.loadFailed')}</div>
            <div className="mt-1 truncate font-mono text-redlog-text-faint" title={loadError}>{loadError}</div>
            <button type="button" onClick={() => void (events.length > 0 ? loadOlder() : load())} className="mt-2 text-red-300 underline hover:text-red-200">
              {t('common.retry')}
            </button>
          </div>
        )}
        {!loading && hasMore && (
          <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className="w-full rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/10 disabled:text-redlog-text-faint">
            {loadingOlder ? t('transcript.loadingOlder') : t('transcript.loadOlder')}
          </button>
        )}
        {!loading && !loadError && shown.length === 0 && (
          buckets.length === 0
            ? (
              <UnappliedFilterNotice
                title={t('filter.unappliedTitle', { condition: `${t('filter.type')}: ${sharedFilter.agentType}` })}
                reason={t('filter.unappliedTranscriptType', {
                  types: TRANSCRIPT_BUCKETS.map((bucket) => bucket.agentType).join(', ')
                })}
              />
            )
            : (
              <EmptyState
                icon={AlignLeft}
                title={t('transcript.empty')}
                reason={t('transcript.emptyReason')}
              />
            )
        )}
        {shown.map((b) => {
          const revealed = expanded.has(b.id)
          const hasOutput = !!b.output || !!b.outputNote
          const big = (b.output?.length ?? 0) > MAX_INLINE
          const body = revealed ? (big ? b.output?.slice(0, MAX_INLINE) : b.output) : undefined
          const fullyExpanded = expanded.has(`${b.id}:full`)
          const displayBody = fullyExpanded && b.output ? b.output : body
          return (
            <div key={b.id} className="rounded border border-redlog-border/70 bg-redlog-bg/40">
              <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-redlog-border/50">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: KIND_COLOR[b.kind] }} />
                <span data-testid="transcript-source-time" title={t('transcript.sourceTime')} className="text-xs text-redlog-text-dim font-mono tabular-nums shrink-0">
                  {t('transcript.sourceTime')} {formatTime(b.ts, { seconds: true })}
                </span>
                <span data-testid="transcript-receipt-time" title={t('transcript.receiptTime')} className="text-xs text-redlog-text-faint font-mono tabular-nums shrink-0">
                  {t('transcript.receiptTime')} {formatTime(b.events[0]?.createdAt ?? b.ts, { seconds: true })}
                </span>
                <span title={b.actor} className="text-xs text-redlog-text-dim font-mono truncate flex-1">{b.actor}</span>
                {b.meta && <span className="text-xs text-redlog-text-faint font-mono shrink-0">{b.meta}</span>}
                {hasOutput && (
                  <button
                    // Stable hook: the e2e reached this by matching the ▶ glyph
                    // inside `button[title]`, which also matched the neighbouring
                    // open-in-timeline control and turned one assertion into a
                    // two-minute locator crawl.
                    data-testid="transcript-toggle"
                    data-expanded={revealed ? 'true' : 'false'}
                    onClick={() => setExpanded((p) => {
                      const next = new Set(p)
                      if (next.has(b.id)) next.delete(b.id); else next.add(b.id)
                      return next
                    })}
                    className="text-xs text-redlog-text-faint hover:text-redlog-text font-mono shrink-0 transition-colors"
                    title={revealed ? t('transcript.collapse') : t('transcript.expand')}
                  >
                    {revealed ? '▼' : '▶'}{b.outputBytes ? ` ${fmtBytes(b.outputBytes)}` : ''}
                  </button>
                )}
                {onOpenInTimeline && (
                  <button
                    onClick={() => onOpenInTimeline(b.id, b.ts)}
                    className="text-xs text-redlog-text-faint hover:text-cyan-400 font-mono shrink-0"
                    title={t('transcript.openInTimeline')}
                  >
                    ↗
                  </button>
                )}
              </div>
              <pre
                className={`px-2.5 py-1.5 text-xs text-redlog-text font-mono break-all ${
                  !revealed && (b.kind === 'agent-turn' || b.kind === 'agent-tool')
                    ? 'whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer'
                    : 'whitespace-pre-wrap'
                }`}
                onClick={!revealed && (b.kind === 'agent-turn' || b.kind === 'agent-tool') ? () => setExpanded((p) => new Set(p).add(b.id)) : undefined}
                title={!revealed && (b.kind === 'agent-turn' || b.kind === 'agent-tool') ? t('transcript.expand') : undefined}
              >
                {!revealed && (b.kind === 'agent-turn' || b.kind === 'agent-tool')
                  ? b.input.split('\n')[0].slice(0, 200)
                  : b.input}
              </pre>
              {revealed && displayBody && (
                <pre className="mx-2.5 mb-2 px-2 py-1.5 bg-redlog-surface/60 rounded border border-redlog-border/60 text-xs text-redlog-text-dim font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
                  {displayBody}
                  {big && !fullyExpanded && (
                    <button
                      onClick={() => setExpanded((p) => new Set(p).add(`${b.id}:full`))}
                      className="block mt-2 text-xs text-cyan-500 hover:text-cyan-400"
                    >
                      {t('transcript.showAll', { size: fmtBytes(b.outputBytes ?? b.output?.length ?? 0) })}
                    </button>
                  )}
                </pre>
              )}
              {revealed && !b.output && b.outputNote && (
                <p className={`mx-2.5 mb-2 px-2 py-1 text-xs font-mono rounded border ${
                  b.outputNote === 'recorded'
                    ? 'text-emerald-400/80 border-emerald-600/30 bg-emerald-900/10'
                    : b.outputNote === 'pending'
                      ? 'text-amber-400/80 border-amber-600/30 bg-amber-900/10'
                      : b.outputNote === 'interrupted'
                        ? 'text-amber-400/80 border-amber-600/30 bg-amber-900/10'
                        : 'text-amber-400/80 border-amber-600/30 bg-amber-900/10'
                }`}>
                  {b.outputNote === 'pending' ? '⏳ ' : ''}{t(`transcript.note.${b.outputNote}`, { size: fmtBytes(b.outputBytes ?? 0) })}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
