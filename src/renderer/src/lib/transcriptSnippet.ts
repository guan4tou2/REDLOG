// Report material from the transcript (#225).
//
// A step copied into a write-up has to say where it came from: which target,
// when (in which timezone), which event and session, and whether the text is
// what was recorded, only part of it, or not there at all. Without that a
// pasted snippet cannot be traced back to the record, and a clipped output
// reads as the whole of it.
//
// Nothing here interprets a step. The text is copied as recorded, newlines
// kept, inside a fence longer than any backtick run it contains, so the
// Markdown cannot swallow or reflow it.

export interface SnippetEvent {
  id: string
  timestamp: number
  targetId?: string | null
  data?: Record<string, unknown>
}

export interface SnippetBlock {
  ts: number
  actor: string
  input: string
  output?: string
  /** size the record says the output was; may exceed `output.length` */
  outputBytes?: number
  /** why there is no inline output */
  outputNote?: string
  meta?: string
  events: SnippetEvent[]
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

function pad(n: number, w = 2): string {
  return String(Math.abs(Math.trunc(n))).padStart(w, '0')
}

/** `2026-09-27 10:00:04 +08:00` — the operator's local time with its offset,
 *  so a reader in another timezone does not have to guess. */
export function localTimeWithOffset(ts: number): string {
  const d = new Date(ts)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(off / 60)}:${pad(off % 60)}`
}

/** A code fence no line of `text` can close early. */
export function fenceFor(text: string): string {
  let longest = 0
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function fenced(text: string): string[] {
  const f = fenceFor(text)
  return [f, text, f]
}

function sessionOf(events: SnippetEvent[]): string | null {
  for (const e of events) {
    const d = e.data ?? {}
    for (const k of ['terminalId', 'terminal_id', 'session_id']) {
      if (typeof d[k] === 'string' && d[k]) return String(d[k])
    }
  }
  return null
}

function targetsOf(events: SnippetEvent[]): string[] {
  return [...new Set(events.map((e) => e.targetId).filter((x): x is string => !!x))]
}

export type OutputState =
  /** the whole output as the record holds it */
  | { kind: 'verbatim' }
  /** the record itself holds only a preview of a larger output */
  | { kind: 'partial-in-record'; kept: number; total: number }
  /** clipped in this copy; the full text is in the event */
  | { kind: 'clipped-here'; kept: number; total: number }
  /** no output text in the record */
  | { kind: 'none'; note: string }

export function outputState(b: SnippetBlock, clipAt?: number): OutputState | null {
  if (b.output) {
    if (clipAt !== undefined && b.output.length > clipAt) return { kind: 'clipped-here', kept: clipAt, total: b.output.length }
    if (b.outputBytes !== undefined && b.outputBytes > b.output.length) {
      return { kind: 'partial-in-record', kept: b.output.length, total: b.outputBytes }
    }
    return { kind: 'verbatim' }
  }
  return b.outputNote ? { kind: 'none', note: b.outputNote } : null
}

/** One step as Markdown, with where it came from. `clipAt` bounds the
 *  output for a long multi-step copy; a single step is copied whole. */
export function blockToMarkdown(b: SnippetBlock, t: Translate, opts: { clipAt?: number } = {}): string {
  const lines: string[] = []
  lines.push(`### ${localTimeWithOffset(b.ts)} — ${b.actor}${b.meta ? ` (${b.meta})` : ''}`, '')
  const targets = targetsOf(b.events)
  const session = sessionOf(b.events)
  lines.push(`- ${t('snippet.target')}: ${targets.length ? targets.map((x) => `\`${x}\``).join(', ') : t('snippet.noTarget')}`)
  lines.push(`- ${t('snippet.time')}: ${localTimeWithOffset(b.ts)} (UTC ${new Date(b.ts).toISOString()})`)
  lines.push(`- ${t('snippet.events')}: ${b.events.map((e) => `\`${e.id}\``).join(', ')}`)
  if (session) lines.push(`- ${t('snippet.session')}: \`${session}\``)
  lines.push('')
  lines.push(...fenced(b.input), '')
  const state = outputState(b, opts.clipAt)
  if (state && b.output) {
    const text = state.kind === 'clipped-here' ? b.output.slice(0, state.kept) : b.output
    lines.push(...fenced(text))
  }
  if (state) {
    switch (state.kind) {
      case 'verbatim': lines.push(`_${t('snippet.verbatim')}_`); break
      case 'partial-in-record': lines.push(`_${t('snippet.partialInRecord', { kept: state.kept, total: state.total })}_`); break
      case 'clipped-here': lines.push(`_${t('snippet.clippedHere', { kept: state.kept, total: state.total })}_`); break
      case 'none': lines.push(`_${t(`transcript.note.${state.note}`, { size: `${b.outputBytes ?? 0} B` })}_`); break
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** Several steps, in the order given, under a header that says what the
 *  selection was and that it is a copy of the record, not an assessment. */
export function blocksToMarkdown(
  blocks: SnippetBlock[],
  t: Translate,
  opts: { clipAt?: number; partialNote?: string; selection?: string } = {}
): string {
  const lines = [`# ${t('snippet.title')}`, '', `> ${t('snippet.disclaimer')}`]
  if (opts.selection) lines.push(`> ${opts.selection}`)
  if (opts.partialNote) lines.push(`> ${opts.partialNote}`)
  lines.push('')
  for (const b of blocks) lines.push(blockToMarkdown(b, t, { clipAt: opts.clipAt }))
  return lines.join('\n')
}
