import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { EmptyState } from './Feedback'
import { emptyStateFor } from '../lib/emptyState'
import { toast } from './Toast'

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
  agentType: string
  operatorId: string
  data?: Record<string, unknown>
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

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

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

    if (e.agentType === 'shell' && sub === 'command_end') {
      const io = d.io as { len?: number; unbracketed?: boolean } | undefined
      const inlineOut = [d.stdout, d.stderr, d.output].filter((x) => typeof x === 'string').join('')
      const exit = Number(d.exit_code ?? 0)
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
        meta: `exit ${exit}${d.duration_sec != null ? ` · ${d.duration_sec}s` : ''}`,
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
          outputNote: 'pending',
          events: [e]
        }
        if (typeof d.tool_use_id === 'string') pendingTool.set(d.tool_use_id as string, b)
        out.push(b)
        continue
      }
      if (sub === 'tool_result') {
        const body = typeof d.output === 'string' ? (d.output as string) : ''
        const b = typeof d.tool_use_id === 'string' ? pendingTool.get(d.tool_use_id as string) : undefined
        if (b) {
          // Fold into the call that produced it — one exchange, not two rows.
          b.output = body
          b.outputBytes = typeof d.output_length === 'number' ? (d.output_length as number) : body.length
          b.outputNote = undefined
          b.events.push(e)
          pendingTool.delete(d.tool_use_id as string)
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

export default function TranscriptView({ onOpenInTimeline, onEmptyAction }: {
  onOpenInTimeline?: (id: string, ts: number) => void
  onEmptyAction?: (target: string) => void
}): JSX.Element {
  const { t } = useI18n()
  const [events, setEvents] = useState<Ev[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<Set<Kind>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await window.redlog.events.query({ limit: 2000 }) as Ev[]
      // queryEvents returns newest-first; a transcript reads oldest-first.
      setEvents([...rows].reverse())
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    try {
      void window.redlog.operators?.list?.().then((ops) => {
        const m: Record<string, string> = {}
        for (const o of (ops ?? []) as Array<{ id: string; name: string }>) m[o.id] = o.name
        setNames(m)
      }).catch(() => {})
    } catch { /* older preload */ }
  }, [])
  useEffect(() => window.redlog.events.onNewBatch?.(() => { void load() }), [load])

  const blocks = useMemo(() => buildBlocks(events, names), [events, names])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return blocks.filter((b) => {
      if (kinds.size && !kinds.has(b.kind)) return false
      if (!q) return true
      return `${b.actor}${b.input}${b.output ?? ''}${b.meta ?? ''}`.toLowerCase().includes(q)
    })
  }, [blocks, query, kinds])

  const toggleKind = (k: Kind): void => setKinds((prev) => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    return next
  })

  const exportMarkdown = useCallback(async () => {
    // The one report-adjacent thing RedLog can offer without becoming a
    // reporting tool: a verbatim transcript, not an assessment.
    const lines: string[] = ['# RedLog transcript', '']
    for (const b of shown) {
      lines.push(`## ${new Date(b.ts).toISOString()} — ${b.actor}${b.meta ? ` (${b.meta})` : ''}`, '')
      lines.push('```', b.input, '```', '')
      if (b.output) lines.push('```', b.output.slice(0, MAX_INLINE), '```', '')
      else if (b.outputNote) lines.push(`_${t(`transcript.note.${b.outputNote}`)}_`, '')
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast(t('transcript.copied'), 'success')
    } catch { toast(t('transcript.copyFailed'), 'error') }
  }, [shown, t])

  const KINDS: Kind[] = ['shell', 'agent-turn', 'agent-tool', 'http', 'marker', 'loot']

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800/60 shrink-0">
        <h1 className="text-sm font-semibold text-zinc-200">{t('transcript.title')}</h1>
        <span className="text-[11px] text-zinc-600 font-mono">{t('transcript.count', { n: shown.length })}</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('transcript.filter')}
          className="ml-2 flex-1 max-w-md bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-700"
        />
        <div className="flex gap-1">
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                kinds.size === 0 || kinds.has(k)
                  ? 'text-zinc-300 border-zinc-700 bg-zinc-800/60'
                  : 'text-zinc-600 border-zinc-800 hover:text-zinc-400'
              }`}
              style={kinds.has(k) ? { color: KIND_COLOR[k], borderColor: `${KIND_COLOR[k]}66` } : undefined}
            >
              {t(`transcript.kind.${k}`)}
            </button>
          ))}
        </div>
        <button
          onClick={() => void exportMarkdown()}
          className="text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors shrink-0"
        >
          {t('transcript.exportMd')}
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {loading && <p className="text-xs text-zinc-600">{t('transcript.loading')}</p>}
        {!loading && shown.length === 0 && (() => {
          const es = emptyStateFor('transcript', { captureDark: false })
          return (
            <EmptyState
              icon="▤"
              title={t(es.titleKey)}
              subtitle={t(es.subtitleKey)}
              action={es.action && es.action.target !== 'doc'
                ? { label: t(es.action.labelKey), onClick: () => onEmptyAction?.(es.action!.target) }
                : undefined}
            />
          )
        })()}
        {shown.map((b) => {
          const open = expanded.has(b.id)
          const big = (b.output?.length ?? 0) > MAX_INLINE
          const body = open || !big ? b.output : b.output?.slice(0, MAX_INLINE)
          return (
            <div key={b.id} className="rounded border border-zinc-800/70 bg-zinc-950/40">
              <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-800/50">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: KIND_COLOR[b.kind] }} />
                <span className="text-[11px] text-zinc-500 font-mono tabular-nums shrink-0">
                  {new Date(b.ts).toLocaleTimeString()}
                </span>
                <span className="text-[11px] text-zinc-400 font-mono truncate flex-1">{b.actor}</span>
                {b.meta && <span className="text-[10px] text-zinc-600 font-mono shrink-0">{b.meta}</span>}
                {onOpenInTimeline && (
                  <button
                    onClick={() => onOpenInTimeline(b.id, b.ts)}
                    className="text-[10px] text-zinc-600 hover:text-cyan-400 font-mono shrink-0"
                    title={t('transcript.openInTimeline')}
                  >
                    ↗
                  </button>
                )}
              </div>
              <pre className="px-2.5 py-1.5 text-xs text-zinc-200 font-mono whitespace-pre-wrap break-all">
                {b.input}
              </pre>
              {body && (
                <pre className="mx-2.5 mb-2 px-2 py-1.5 bg-zinc-900/60 rounded border border-zinc-800/60 text-xs text-zinc-400 font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
                  {body}
                  {big && !open && (
                    <button
                      onClick={() => setExpanded((p) => new Set(p).add(b.id))}
                      className="block mt-2 text-[10px] text-cyan-500 hover:text-cyan-400"
                    >
                      {t('transcript.showAll', { size: fmtBytes(b.outputBytes ?? b.output?.length ?? 0) })}
                    </button>
                  )}
                </pre>
              )}
              {!b.output && b.outputNote && (
                <p className={`mx-2.5 mb-2 px-2 py-1 text-[11px] font-mono rounded border ${
                  b.outputNote === 'recorded'
                    ? 'text-emerald-400/80 border-emerald-600/30 bg-emerald-900/10'
                    : b.outputNote === 'pending'
                      ? 'text-zinc-500 border-zinc-800/60 bg-zinc-900/30'
                      : 'text-amber-400/80 border-amber-600/30 bg-amber-900/10'
                }`}>
                  {t(`transcript.note.${b.outputNote}`, { size: fmtBytes(b.outputBytes ?? 0) })}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
