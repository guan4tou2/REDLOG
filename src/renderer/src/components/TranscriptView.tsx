import { operationPairKey } from '../../../core/operation-pair-key'
import { buildToolPairIndex } from '../lib/toolPairing'
import type { ToolPairKey } from '../../../core/db/events'
import { Button } from './Button'
import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { formatTime, formatDateTime, formatLag, formatSize } from '../lib/time'
import { EmptyState } from './EmptyState'
import { UnappliedFilterNotice } from './FilterNotice'
import { parseQuery, type ParseOutcome } from '../../../core/query/contract'
import { QueryReadout } from './QueryReadout'
import { AlignLeft } from 'lucide-react'
import { useContributeExport } from '../lib/exportScope'
import { toEventFilter, useSharedFilter } from '../lib/FilterContext'
import { blockToMarkdown, blocksToMarkdown } from '../lib/transcriptSnippet'
import { summarizeLateOutput, type LateOutputSummary } from '../lib/lateOutput'
import { pickedSteps, PICK_CATEGORIES, type PickCategory } from '../lib/transcriptPicks'
import { EventContentReader } from './EventContentReader'

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
  engagementId?: string
  sessionId?: string
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
  return operationPairKey(e)
}

async function completeToolPairs(events: Ev[]): Promise<Ev[]> {
  const seenKinds = new Map<string, Set<unknown>>()
  const keyParts = new Map<string, ToolPairKey>()
  for (const event of events) {
    const key = toolPairKey(event)
    if (!key) continue
    const d = event.data ?? {}
    const kinds = seenKinds.get(key) ?? new Set()
    kinds.add(d.subtype)
    seenKinds.set(key, kinds)
    keyParts.set(key, { sessionId: String(d.session_id), toolUseId: String(d.tool_use_id), provider: String(d.agent), engagementId: event.engagementId!, captureSessionId: event.sessionId! })
  }
  const missing = [...seenKinds]
    .filter(([, kinds]) => !(kinds.has('tool_call') && (kinds.has('tool_result') || kinds.has('tool_interrupted'))))
    .map(([key]) => keyParts.get(key)!)
  if (missing.length === 0) return events
  const counterparts = await window.redlog.events.toolCounterparts(missing) as Ev[]
  const byId = new Map(events.map((event) => [event.id, event]))
  for (const event of counterparts) {
    const key = toolPairKey(event)
    if (key && seenKinds.has(key)) byId.set(event.id, event)
  }
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
  /** a finished command's exit code, when known */
  exitCode?: number | null
  events: Ev[]
}

const MAX_INLINE = 4096
/** How close to the live end still counts as being at it. */
const LIVE_EDGE_PX = 8

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

interface EventPage extends BucketPageState {
  items: Ev[]
}

/** Union by id, oldest first. Events are append-only, so a known id is never stale. */
function mergeEvents(current: Ev[], incoming: Ev[]): Ev[] {
  const byId = new Map(current.map((event) => [event.id, event]))
  let added = false
  for (const event of incoming) {
    if (byId.has(event.id)) continue
    byId.set(event.id, event)
    added = true
  }
  return added ? [...byId.values()].sort((a, b) => a.timestamp - b.timestamp) : current
}

const fmtBytes = formatSize

// Theme variables, not hex: the transcript's kinds take their colours from
// the palette like everything else (UI/UX audit F24).
const KIND_COLOR: Record<Kind, string> = {
  shell: 'var(--color-emerald-500)',
  'agent-turn': 'var(--color-lime-400)',
  'agent-tool': 'var(--color-redlog-text-dim)',
  http: 'var(--color-purple-400)',
  marker: 'var(--color-red-400)',
  loot: 'var(--color-orange-400)',
  other: 'var(--color-redlog-muted)'
}

/**
 * Fold the event stream into exchanges.
 *
 * The pairing rules mirror what the Timeline already knows: shell
 * agent tool_call/tool_result share the canonical source-scoped key;
 * command completion stays source-linked; HTTP request/response share flow_id. Where a pair is
 * incomplete — the command is still running, the response never came — the
 * block renders with the half that exists and says so.
 */
function buildBlocks(events: Ev[], names: Record<string, string>, t: (k: string, v?: Record<string, string | number>) => string, late: Record<string, LateOutputSummary> = {}): Block[] {
  const out: Block[] = []
  const pendingTool = new Map<string, Block>()
  const toolPairs = buildToolPairIndex(events)
  const safeToolKey = (event: Ev): string | null => {
    const key = toolPairKey(event)
    return key && !toolPairs.conflicts.has(key) ? key : null
  }
  const pendingHttp = new Map<string, Block>()
  const actorOf = (e: Ev): string => names[e.operatorId] ?? e.operatorId

  for (const e of events) {
    const d = e.data ?? {}
    const sub = String(d.subtype ?? '')

    if (e.agentType === 'shell' && sub === 'session_output') {
      const output = String(d.stdout ?? '')
      out.push({ id: e.id, ts: e.timestamp, kind: 'shell', actor: actorOf(e),
        input: t('transcript.sessionChunk', { terminal: String(d.terminalId ?? ''), seq: String(d.sequence ?? '') }),
        output, outputBytes: output.length, meta: t('transcript.metaPtyMerged'), events: [e] })
      continue
    }

    if (e.agentType === 'shell' && sub === 'command_end') {
      const io = d.io as { len?: number; unbracketed?: boolean } | undefined
      // A background job's later output is part of this command. Nothing is
      // said about it while it is whole; only a still-open or lossy one is.
      const lateSum = (d.late_output === true || d.output_streamed === true) && typeof d.command_id === 'string' ? late[d.command_id] : undefined
      const inlineOut = [d.stdout, d.stderr, lateSum?.stdout, lateSum?.stderr].filter((x) => typeof x === 'string').join('')
      const lateNote = lateSum?.state === 'preview' ? ` · ${t('timeline.detail.outputPreview')}`
        : lateSum?.state === 'running' ? ` · ${t('transcript.metaLateRunning')}`
        : lateSum?.state === 'incomplete' ? ` · ${t('transcript.metaLateIncomplete')}` : ''
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
        meta: `${exitKnown ? t('transcript.metaExit', { code: String(exit) }) : t('transcript.metaExitUnknown')}${d.duration_sec != null ? ` · ${d.duration_sec}s` : ''}${lateNote}`,
        exitCode: exit,
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
        const tk = safeToolKey(e)
        const result = tk ? toolPairs.results.get(tk) : undefined
        if (result?.data) {
          b.output = typeof result.data.output === 'string' ? result.data.output : ''
          b.outputBytes = typeof result.data.output_length === 'number' ? result.data.output_length : b.output.length
          b.outputNote = undefined
          b.events.push(result)
        } else if (tk) pendingTool.set(tk, b)
        out.push(b)
        continue
      }
      if (sub === 'tool_interrupted') {
        const tk = safeToolKey(e)
        const b = tk ? pendingTool.get(tk) : undefined
        if (b) {
          b.outputNote = 'interrupted'
          b.events.push(e)
          pendingTool.delete(tk!)
        } else {
          out.push({
            id: e.id, ts: e.timestamp, kind: 'agent-tool', actor: String(d.agent ?? 'agent'),
            input: t('transcript.toolInterrupted'), outputNote: 'interrupted', events: [e]
          })
        }
        continue
      }
      if (sub === 'tool_result') {
        const body = typeof d.output === 'string' ? (d.output as string) : ''
        const tk = safeToolKey(e)
        if (tk && toolPairs.calls.has(tk)) continue
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
            input: t('transcript.toolResultUnpaired'), output: body, events: [e]
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

function pickBadges(b: Block, picks: Map<string, Set<PickCategory>>): PickCategory[] {
  const out = new Set<PickCategory>()
  for (const e of b.events) for (const c of picks.get(e.id) ?? []) out.add(c)
  return PICK_CATEGORIES.filter((c) => out.has(c))
}

function safeJson(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

export default function TranscriptView({ onOpenInTimeline, active = true, reading, externalQuery, sessionExport }: {
  onOpenInTimeline?: (id: string, ts: number) => void
  active?: boolean
  reading?: 'io' | 'ai'
  externalQuery?: string
  sessionExport?: Extract<ExportRequest['subset'],{kind:'session'}>
}): JSX.Element {
  const { t } = useI18n()
  const { filter: sharedFilter } = useSharedFilter()
  const unsupportedExport = useMemo<ExportRequest>(() => ({ format: 'json', subset: { kind: 'selection', projection: 'events', filter: toEventFilter(sharedFilter) } }), [sharedFilter])
  // Blocks, pair completion and picked steps are not a raw event predicate.
  useContributeExport(active ? sessionExport ? {label:t('activity.export.session'),request:{format:'json',subset:sessionExport}} : { label: t('export.current'), request: unsupportedExport, disabledReason: t('export.transcriptLimit') } : null)
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
  const [pickedOnly, setPickedOnly] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const loadSeqRef = useRef(0)
  // Where the operator is reading. Rows arriving above that point must not
  // move it, and an operator parked at the live end should stay there.
  const followRef = useRef(false)
  const anchorRef = useRef<{ id: string; offset: number } | null>(null)
  // Rows newer than any the reader has had on screen, counted while they are
  // away from the live end. Older pages they asked for are not news.
  const newestSeenRef = useRef<number | null>(null)
  const [unseen, setUnseen] = useState(0)

  useEffect(() => {
    if (!active) return
    const id = setTimeout(() => setActiveQuery(externalQuery ?? query), 300)
    return () => clearTimeout(id)
  }, [query, externalQuery, active])

  // Spec 017: the parse happens here, so the surface can show how it read the
  // query and a half-typed condition never becomes a store query at all.
  const parse: ParseOutcome | null = useMemo(
    () => (activeQuery.trim() ? parseQuery(activeQuery) : null),
    [activeQuery]
  )
  const backendQuery = parse?.ok ? parse.parsed : null
  const parseFailed = parse !== null && !parse.ok

  const buckets = useMemo(() => TRANSCRIPT_BUCKETS.filter(bucket =>
    (!sharedFilter.agentType || bucket.agentType === sharedFilter.agentType)
    && (!reading || (reading === 'ai' ? bucket.agentType === 'agent' : ['shell', 'scanner'].includes(bucket.agentType)))
  ), [sharedFilter.agentType, reading])

  // One page of one bucket: the newest when there is no cursor.
  const fetchPage = useCallback(async (bucket: { agentType: string; limit: number }, cursor?: string | null): Promise<EventPage> => (
    backendQuery
      ? await window.redlog.events.runQuery({
        parsed: backendQuery,
        ...(sessionExport ? {snapshot:sessionExport.snapshot} : {}),
        filter: { ...toEventFilter(sharedFilter), agentType: bucket.agentType },
        limit: bucket.limit,
        ...(cursor ? { cursor } : {})
      })
      : await window.redlog.events.queryPage({
        ...toEventFilter(sharedFilter),
        ...bucket,
        // Background-output chunks belong to their command, not beside it.
        excludeHousekeeping: true,
        ...(cursor ? { cursor } : {})
      })
  ) as EventPage, [backendQuery, sharedFilter.targetId, sharedFilter.timeRange, sharedFilter.inScopeOnly, sharedFilter.hidePersonal, sharedFilter.tier, sessionExport?.snapshot])

  // Read by the async merges, which must see the rows of the moment they
  // finish rather than the render that started them.
  const eventsRef = useRef<Ev[]>(events)
  eventsRef.current = events

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setLoadingOlder(false)
    setLoadError(null)
    setEvents([])
    setBucketPages({})
    newestSeenRef.current = null
    setUnseen(0)
    try {
      // Balanced per-type query so high-volume types (HTTP/scanner) don't
      // crowd out AI conversation and shell events.
      const results = await Promise.all(buckets.map(async (bucket) => ({ bucket, page: await fetchPage(bucket) })))
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
      if (reading) setExpanded(prev => new Set([...prev, ...completed.map(event => event.id)]))
      setBucketPages(pages)
    } catch (error: unknown) {
      if (seq === loadSeqRef.current) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [buckets, fetchPage, reading])

  // A new batch re-reads the newest page of each bucket and merges it in.
  // Clearing and reloading everything blanked the list, threw away the older
  // pages the operator had loaded and lost their place — on every batch, which
  // an active agent session produces several times a second. Batches that
  // arrive while a refresh is in flight collapse into one more refresh.
  const refreshingRef = useRef(false)
  const refreshAgainRef = useRef(false)
  const refreshHead = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) { refreshAgainRef.current = true; return }
    refreshingRef.current = true
    const seq = loadSeqRef.current
    try {
      const results = await Promise.all(buckets.map(async (bucket) => ({ bucket, page: await fetchPage(bucket) })))
      if (seq !== loadSeqRef.current) return
      const known = new Set(eventsRef.current.map((event) => event.id))
      // More arrived than one page holds: the head no longer meets what is
      // loaded, and merging would leave a hole that reads as nothing happening.
      if (results.some(({ page }) => page.hasMore && !page.items.some((event) => known.has(event.id)))) {
        void load()
        return
      }
      const incoming = results.flatMap(({ page }) => page.items)
      if (incoming.every((event) => known.has(event.id))) return
      const completed = await completeToolPairs(mergeEvents(eventsRef.current, incoming))
      if (seq !== loadSeqRef.current) return
      setEvents((current) => mergeEvents(current, completed))
    } catch {
      // The rows on screen are still correct, only not the newest; the next
      // batch tries again.
    } finally {
      refreshingRef.current = false
      if (refreshAgainRef.current) {
        refreshAgainRef.current = false
        void refreshHead()
      }
    }
  }, [buckets, fetchPage, load])

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
        page: await fetchPage(bucket, bucketPages[bucket.agentType].nextCursor)
      })))
      if (seq !== loadSeqRef.current) return
      const completed = await completeToolPairs(mergeEvents(eventsRef.current, results.flatMap(({ page }) => page.items)))
      if (seq !== loadSeqRef.current) return
      setEvents((current) => mergeEvents(current, completed))
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
  }, [bucketPages, buckets, fetchPage, loadingOlder])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void window.redlog.operators.list().then((ops) => {
      const m: Record<string, string> = {}
      for (const o of ops as Array<{ id: string; name: string }>) m[o.id] = o.name
      setNames(m)
    }).catch(() => {})
  }, [])
  const headStale = useRef(false)
  useEffect(() => window.redlog.events.onNewBatch(() => {
    if(sessionExport)return
    if (active) void refreshHead()
    else headStale.current = true
  }), [refreshHead, active, sessionExport])
  useEffect(() => {
    if (active && headStale.current) { headStale.current = false; void refreshHead() }
  }, [active, refreshHead])

  // What background commands printed after their prompt came back. It belongs
  // to the command's own block, so it is read per command rather than listed.
  const [lateOutput, setLateOutput] = useState<Record<string, LateOutputSummary>>({})
  useEffect(() => {
    const ids = events
      .filter((e) => e.agentType === 'shell' && e.data?.subtype === 'command_end' && (e.data?.late_output === true || e.data?.output_streamed === true) && typeof e.data?.command_id === 'string')
      .map((e) => e.data?.command_id as string)
    if (ids.length === 0) { setLateOutput((cur) => (Object.keys(cur).length === 0 ? cur : {})); return }
    let live = true
    void Promise.all(ids.map((id) => window.redlog.events.commandOutput(id)
      .then((rows) => [id, summarizeLateOutput(rows.items, rows.hasMore)] as const)
      .catch(() => null)))
      .then((pairs) => {
        if (live) setLateOutput(Object.fromEntries(pairs.filter((p): p is readonly [string, LateOutputSummary] => p !== null)))
      })
    return () => { live = false }
  }, [events])

  const blocks = useMemo(() => buildBlocks(events, names, t, lateOutput), [events, names, t, lateOutput])
  const hasMore = Object.values(bucketPages).some((page) => page.hasMore)

  const autoExpandedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const toExpand: string[] = []
    for (const b of blocks) {
      if (autoExpandedRef.current.has(b.id)) continue
      autoExpandedRef.current.add(b.id)
      if (b.kind === 'loot') { toExpand.push(b.id); continue }
      if (b.kind === 'shell' && typeof b.exitCode === 'number' && b.exitCode !== 0) toExpand.push(b.id)
    }
    if (toExpand.length > 0) {
      setExpanded((prev) => { const next = new Set(prev); for (const id of toExpand) next.add(id); return next })
    }
  }, [blocks])

  // #225: steps the operator picked — markers citing the events of a block.
  const picks = useMemo(() => pickedSteps(events), [events])

  const shown = useMemo(
    // Text is matched by the store now. Filtering again over the rendered
    // block would drop a row whose match lies in a field the block does not
    // show, making the answer depend on the presentation. Kind stays local and
    // is labelled as such.
    () => blocks.filter((b) => (!kinds.size || kinds.has(b.kind))
      && (!pickedOnly || b.events.some((e) => picks.has(e.id)))),
    [blocks, kinds, pickedOnly, picks]
  )

  // Blocks are built oldest first (a tool result pairs with the call before it).
  // The list shows newest first by default — what just happened is what is
  // looked for — and the operator can flip it.
  const [newestFirst, setNewestFirst] = useState<boolean>(() => {
    try { return localStorage.getItem('redlog.transcript.order') !== 'oldest' } catch { return true }
  })
  const toggleOrder = (): void => setNewestFirst((v) => {
    try { localStorage.setItem('redlog.transcript.order', v ? 'oldest' : 'newest') } catch { /* order is a convenience only */ }
    return !v
  })
  // Render order only: the Markdown copy and everything else stay oldest first.
  const displayed = useMemo(() => (newestFirst ? [...shown].reverse() : shown), [shown, newestFirst])

  const recordPosition = useCallback((): void => {
    const body = bodyRef.current
    if (!body) return
    followRef.current = newestFirst
      ? body.scrollTop <= LIVE_EDGE_PX
      : body.scrollHeight - body.scrollTop - body.clientHeight <= LIVE_EDGE_PX
    if (followRef.current) setUnseen(0)
    anchorRef.current = null
    for (const el of body.querySelectorAll<HTMLElement>('[data-block-id]')) {
      if (el.offsetTop + el.offsetHeight > body.scrollTop) {
        anchorRef.current = { id: el.dataset.blockId ?? '', offset: el.offsetTop - body.scrollTop }
        break
      }
    }
  }, [newestFirst])

  // Before paint, put the reader back: at the live end if they were there,
  // otherwise with the row they were reading at the same height. The body
  // opts out of the browser's own scroll anchoring so only this moves it.
  useLayoutEffect(() => {
    const body = bodyRef.current
    const anchor = anchorRef.current
    const newest = shown.length > 0 ? shown[shown.length - 1].ts : null
    const seen = newestSeenRef.current
    if (seen !== null && !followRef.current) {
      const fresh = shown.filter((b) => b.ts > seen).length
      if (fresh > 0) setUnseen((n) => n + fresh)
    }
    if (newest !== null && (seen === null || newest > seen)) newestSeenRef.current = newest
    if (body && followRef.current) {
      body.scrollTop = newestFirst ? 0 : body.scrollHeight
    } else if (body && anchor) {
      for (const el of body.querySelectorAll<HTMLElement>('[data-block-id]')) {
        if (el.dataset.blockId === anchor.id) { body.scrollTop = el.offsetTop - anchor.offset; break }
      }
    }
    recordPosition()
  }, [displayed, recordPosition])

  const toLiveEnd = (): void => {
    const body = bodyRef.current
    if (body) body.scrollTop = newestFirst ? 0 : body.scrollHeight
    recordPosition()
  }
  // Always rendered and zero-height, so the button appearing does not itself
  // push the rows it is about down.
  const unseenButton = (
    <div className={`sticky ${newestFirst ? 'top-0' : 'bottom-0'} z-10 h-0 flex justify-center`}>
      {unseen > 0 && (
        <button type="button" data-testid="transcript-unseen" onClick={toLiveEnd}
          className={`${newestFirst ? '' : '-translate-y-full'} h-fit rounded-full border border-redlog-cyan/40 bg-redlog-surface px-3 py-1 text-xs text-redlog-cyan shadow`}>
          {t('transcript.unseen', { n: unseen })}
        </button>
      )}
    </div>
  )

  // Picking a step records a marker that cites it. The step's own events are
  // never edited, and the pick is append-only like any marker.
  const pickStep = useCallback(async (b: Block, category: PickCategory) => {
    setPicking(null)
    const first = b.input.split('\n')[0].slice(0, 80)
    try {
      const ev = await window.redlog.marker.create({
        title: `${t(`marker.category.${category}`)}: ${first}`,
        severity: 'info',
        category,
        atTimestamp: b.ts,
        causes: b.events.map((e) => e.id),
        ...(b.events[0]?.targetId ? { targetId: b.events[0].targetId } : {})
      })
      if (!ev) throw new Error('no-active-project')
      toast(t('transcript.picked', { kind: t(`marker.category.${category}`) }), 'success')
      void refreshHead()
    } catch (err) {
      toast(t('transcript.pickFailed'), { type: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }, [refreshHead, t])

  const copyStep = useCallback(async (b: Block) => {
    if (await writeClipboard(blockToMarkdown(b, t))) toast(t('transcript.stepCopied'), 'success')
    else toast(t('transcript.copyFailed'), { type: 'error', why: t('transcript.copyFailedWhy') })
  }, [t])

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
    const text = blocksToMarkdown(shown, t, {
      clipAt: MAX_INLINE,
      partialNote: hasMore ? t('transcript.partialMarkdown') : undefined,
      selection: pickedOnly ? t('transcript.selectionPicked') : undefined
    })
    if (await writeClipboard(text)) {
      toast(t('transcript.copied'), 'success')
    } else {
      toast(t('transcript.copyFailed'), {
        type: 'error',
        why: t('transcript.copyFailedWhy')
      })
    }
  }, [hasMore, pickedOnly, shown, t])

  // What loads older rows (and says it could not) sits where they would appear:
  // below the list when newest is on top, above it when oldest is.
  const olderBlock = (
    <>
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
    </>
  )

  const KINDS: Kind[] = ['shell', 'agent-turn', 'agent-tool', 'http', 'marker', 'loot']

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-2 gap-y-1 px-4 py-2 border-b border-redlog-border/60 shrink-0">
        {!reading && <h1 className="text-sm font-semibold text-redlog-text">{t('transcript.title')}</h1>}
        <span className="text-xs text-redlog-text-faint font-mono">{t('transcript.count', { n: shown.length })}</span>
        {!loading && (!loadError || events.length > 0) && (
          <span data-testid="transcript-completeness" className={`text-xs ${hasMore ? 'text-amber-400' : 'text-emerald-500'}`}>
            {t(backendQuery
              ? (hasMore ? 'transcript.querySubset' : 'transcript.queryComplete')
              : (hasMore ? 'transcript.recentSubset' : 'transcript.complete'))}
          </span>
        )}
        {externalQuery === undefined && <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('transcript.filter')}
          className="min-w-[min(12rem,100%)] flex-1 max-w-md bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text placeholder-redlog-text-faint focus:outline-none focus:border-redlog-border"
        />}
        {(!reading || (parse?.ok && parse.parsed.conditions.length > 0)) && <QueryReadout outcome={parse?.ok ? parse : null} testId="transcript-query" unparsableTitle={t('transcript.queryUnparsable')} />}
        {!reading && <div className="flex gap-1">
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors ${
                kinds.size === 0 || kinds.has(k)
                  ? 'text-redlog-text border-redlog-border bg-redlog-elevated/60'
                  : 'text-redlog-text-faint border-redlog-border hover:text-redlog-text-dim'
              }`}
              style={kinds.has(k) ? { color: KIND_COLOR[k], borderColor: `color-mix(in oklab, ${KIND_COLOR[k]} 40%, transparent)` } : undefined}
            >
              {t(`transcript.kind.${k}`)}
            </button>
          ))}
        </div>}
        <Button size="compact" level="quiet"
          type="button"
          data-testid="transcript-picked-only"
          aria-pressed={pickedOnly}
          onClick={() => setPickedOnly((v) => !v)}
          title={t('transcript.pickedOnlyHint')}
        >
          {t('transcript.pickedOnly', { n: picks.size ? new Set(blocks.filter((b) => b.events.some((e) => picks.has(e.id))).map((b) => b.id)).size : 0 })}
        </Button>
        <Button size="compact" level="quiet"
          type="button"
          data-testid="transcript-order"
          onClick={toggleOrder}
          title={t('transcript.orderHint')}
        >
          {newestFirst ? t('transcript.orderNewest') : t('transcript.orderOldest')}
        </Button>
        <Button size="compact" level="quiet"
          onClick={() => void copyAsMarkdown()}
        >
          {t('transcript.copyMd')}
        </Button>
      </div>

      <div ref={bodyRef} onScroll={recordPosition} data-testid="transcript-body" className="relative flex-1 min-h-0 overflow-y-auto [overflow-anchor:none] px-4 py-3 space-y-2">
        {/* Unparsable is its own state. It is not a failure — nothing was
            asked — and it is emphatically not an empty result, which would
            invite reading a typo as proof the evidence is absent. */}
        <QueryReadout outcome={parseFailed && parse && !parse.ok ? parse : null} testId="transcript-query" unparsableTitle={t('transcript.queryUnparsable')} />
        {toolSession && (
          <div data-testid="transcript-tool-session" role="status" className="rounded border border-redlog-cyan/40 bg-redlog-cyan/10 px-3 py-2 text-xs text-redlog-cyan">
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
        {!loading && !loadError && shown.length === 0 && (
          reading && buckets.length === 0 && TRANSCRIPT_BUCKETS.some(bucket => bucket.agentType === sharedFilter.agentType)
            ? <p role="status" className="text-xs text-redlog-text-dim">{t('workspace.noScopeMatches')}</p>
            : buckets.length === 0
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
        {!newestFirst && olderBlock}
        {newestFirst && unseenButton}
        {displayed.map((b) => {
          const revealed = expanded.has(b.id)
          const hasOutput = !!b.output || !!b.outputNote
          const big = (b.output?.length ?? 0) > MAX_INLINE
          const body = revealed ? (big ? b.output?.slice(0, MAX_INLINE) : b.output) : undefined
          const fullyExpanded = expanded.has(`${b.id}:full`)
          const displayBody = fullyExpanded && b.output ? b.output : body
          const savedSource = [...b.events].reverse().find(event => typeof event.engagementId === 'string' && event.engagementId)
          const readerOpen = expanded.has(`${b.id}:reader`)
          // Source time and receipt time (Domain Invariant #8). They are equal
          // for anything captured live, which is almost everything — so the row
          // shows one time, and the second only earns its place in the row when
          // the two actually diverge: a replayed transcript, a spool that was
          // offline. Printing both unconditionally cost ~150px of a header
          // whose only flexible element is the actor name, to say the same
          // thing twice.
          const recordedAt = b.events[0]?.createdAt ?? b.ts
          // `lag` gates the badge and has a floor, because a sub-second gap is
          // not worth a mark in the row. `diverged` gates the tooltip and has
          // none: Invariant #8 is about every displayed result, so whenever the
          // two times are not the same number the row has to be able to say so.
          const diverged = recordedAt !== b.ts
          const lag = formatLag(recordedAt - b.ts, t)
          const timeTitle = diverged
            ? t('transcript.lagTitle', {
              occurred: formatDateTime(b.ts, { seconds: true }),
              recorded: formatDateTime(recordedAt, { seconds: true })
            })
            : formatDateTime(b.ts, { seconds: true })
          return (
            <div key={b.id} data-block-id={b.id} className="rounded border border-redlog-border/70 bg-redlog-bg/40">
              <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-redlog-border/50">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: KIND_COLOR[b.kind] }} />
                <span
                  data-testid="transcript-source-time"
                  data-occurred-at={b.ts}
                  title={timeTitle}
                  className="text-xs text-redlog-text-faint font-mono tabular-nums shrink-0 w-16"
                >
                  {formatTime(b.ts, { seconds: true })}
                </span>
                {lag && (
                  <span
                    data-testid="transcript-receipt-time"
                    data-recorded-at={recordedAt}
                    title={timeTitle}
                    className="text-xs text-amber-400 font-mono tabular-nums shrink-0"
                  >
                    {lag}
                  </span>
                )}
                <span title={b.actor} className="text-xs text-redlog-text-dim font-mono truncate flex-1">{b.actor}</span>
                {b.meta && (
                  <span
                    data-testid="transcript-meta"
                    className={`text-xs font-mono shrink-0 ${typeof b.exitCode === 'number' && b.exitCode !== 0 ? 'text-amber-400' : 'text-redlog-text-faint'}`}
                  >{b.meta}</span>
                )}
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
                {pickBadges(b, picks).map((c) => (
                  <span key={c} data-testid="transcript-pick-badge" className={`text-xs font-mono shrink-0 ${c === 'failed_attempt' ? 'text-amber-400' : 'text-red-400'}`}>
                    ⚑ {t(`marker.category.${c}`)}
                  </span>
                ))}
                {b.kind !== 'marker' && (
                  picking === b.id
                    ? PICK_CATEGORIES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        data-testid={`transcript-pick-${c}`}
                        onClick={() => void pickStep(b, c)}
                        className="text-xs px-1.5 rounded border border-redlog-border text-redlog-text-dim hover:text-redlog-text shrink-0"
                      >
                        {t(`marker.category.${c}`)}
                      </button>
                    ))
                    : (
                      <button
                        type="button"
                        data-testid="transcript-pick"
                        onClick={() => setPicking(b.id)}
                        className="text-xs text-redlog-text-faint hover:text-red-400 font-mono shrink-0"
                        title={t('transcript.pick')}
                        aria-label={t('transcript.pick')}
                      >
                        ⚑
                      </button>
                    )
                )}
                <button
                  type="button"
                  data-testid="transcript-copy-step"
                  onClick={() => void copyStep(b)}
                  className="text-xs text-redlog-text-faint hover:text-redlog-text font-mono shrink-0"
                  title={t('transcript.copyStep')}
                  aria-label={t('transcript.copyStep')}
                >
                  ⧉
                </button>
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
                  ? (b.kind === 'agent-tool' ? b.input.replace(/\n\s*/g, ' ') : b.input.split('\n')[0]).slice(0, 200)
                  : b.input}
              </pre>
              {revealed && !readerOpen && displayBody && (
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
              {savedSource && (big || b.outputNote === 'recorded' || reading) && <div className="px-2.5 pb-2 min-w-0">
                <Button size="compact" level="quiet" aria-expanded={readerOpen}
                  onClick={() => setExpanded(prev => {
                    const next = new Set(prev)
                    if (readerOpen) next.delete(`${b.id}:reader`); else next.add(`${b.id}:reader`)
                    return next
                  })}>{t('content.savedContent')}</Button>
                <div hidden={!readerOpen}>
                  {readerOpen && <EventContentReader active={active} projectId={savedSource.engagementId!} eventId={savedSource.id} />}
                </div>
              </div>}
            </div>
          )
        })}
        {!newestFirst && unseenButton}
        {newestFirst && olderBlock}
      </div>
    </div>
  )
}
