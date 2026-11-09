// One event as a card on the Timeline's rail (Stitch 05). Every part of a card
// is a field the event already carries, or the event's own title. Nothing here
// describes what an event "means": no summary sentences, no inference from
// output ("port open", "flag captured"), no verbs the recorder did not
// observe. A part the event has no field for is absent, not invented.

import type { RedLogEvent } from '../../../core/db/event-types'
import { SCOPE_VIOLATION_SUBTYPE } from '../../../core/scope-vocabulary'
import { formatTime } from './time'
import { LANE_LABEL_KEYS, toLane, type LaneId, type PluginEventType } from './timelineDomain'
import { formatBytes } from '../components/HttpDetail'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export interface CardContext {
  t: Translate
  titleOf: (e: RedLogEvent) => string
  pluginTypes: PluginEventType[]
  /** Only the focused card shows output; the rest never touch it. */
  withStdout?: boolean
}

export interface EventCard {
  lane: LaneId
  time: string
  typeTag: string
  title: string
  detail?: string
  /** Right-hand facts: exit code, status, size, duration. */
  meta: string[]
  /** The start of inline `data.stdout`, when the event carries it. */
  stdout?: string
}

const STDOUT_CHARS = 400
const STDOUT_LINES = 6

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function durationOf(d: Record<string, unknown>): string | null {
  const sec = num(d.duration_sec)
  if (sec !== null) return `${sec}s`
  const ms = num(d.duration_ms)
  return ms !== null ? `${ms} ms` : null
}

function metaOf(evt: RedLogEvent, t: Translate): string[] {
  const d = evt.data ?? {}
  const meta: string[] = []
  const duration = durationOf(d)
  switch (evt.agentType) {
    case 'shell': {
      const code = num(d.exit_code)
      if (d.subtype === 'command_end' && code !== null) meta.push(t('transcript.metaExit', { code }))
      if (d.subtype === 'command_end' && duration) meta.push(duration)
      break
    }
    case 'scanner': {
      const status = num(d.status)
      if (status !== null) meta.push(String(status))
      const size = num(d.content_length) ?? num(d.size)
      if (size !== null) meta.push(formatBytes(size))
      if (duration) meta.push(duration)
      break
    }
    case 'file_transfer': {
      const size = num(d.size)
      if (size !== null) meta.push(formatBytes(size))
      break
    }
    default:
      // process exit, DNS answer, an agent's tool call: a duration only when
      // the event recorded one.
      if (duration) meta.push(duration)
  }
  return meta
}

function detailOf(evt: RedLogEvent): string | undefined {
  const d = evt.data ?? {}
  switch (evt.agentType) {
    case 'shell':
    case 'process':
      return str(d.cwd) || undefined
    case 'scanner':
      return d.subtype === 'http_response' ? str(d.content_type) || undefined : undefined
    case 'loot': {
      const matches = Array.isArray(d.matches) ? (d.matches as Array<{ type?: unknown }>) : []
      const types = [...new Set(matches.map((m) => str(m?.type).replace(/_/g, ' ')).filter(Boolean))]
      return types.length ? types.join(' · ') : undefined
    }
    default:
      return undefined
  }
}

/** The start of inline stdout, or undefined. Only `data.stdout` counts: a
 *  stored sidecar is not read here (no IPC per card) and nothing else is
 *  passed off as output. */
export function stdoutStart(evt: RedLogEvent): string | undefined {
  const out = evt.data?.stdout
  if (typeof out !== 'string' || out.trim() === '') return undefined
  const lines = out.split('\n').slice(0, STDOUT_LINES).join('\n')
  return lines.length > STDOUT_CHARS ? `${lines.slice(0, STDOUT_CHARS)}…` : lines
}

function typeTagOf(evt: RedLogEvent, lane: LaneId, t: Translate): string {
  if (lane === 'loot') return t('timeline.card.lootHit')
  if (evt.agentType === 'system' && evt.data?.subtype === SCOPE_VIOLATION_SUBTYPE && evt.data?.distance !== 'in_scope') {
    return t('timeline.card.scopeObservation')
  }
  return t(LANE_LABEL_KEYS[lane])
}

export function buildCard(evt: RedLogEvent, ctx: CardContext): EventCard {
  const lane = toLane(evt.agentType, evt.data?.subtype as string | undefined, ctx.pluginTypes)
  const card: EventCard = {
    lane,
    time: formatTime(evt.timestamp, { seconds: true }),
    typeTag: typeTagOf(evt, lane, ctx.t),
    title: ctx.titleOf(evt),
    meta: metaOf(evt, ctx.t)
  }
  const detail = detailOf(evt)
  if (detail) card.detail = detail
  if (ctx.withStdout) {
    const stdout = stdoutStart(evt)
    if (stdout) card.stdout = stdout
  }
  return card
}
