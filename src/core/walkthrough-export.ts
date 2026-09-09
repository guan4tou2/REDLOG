import { aggregateTargets, hostCausalChain, type RedLogEvent } from './db/events'
import { redactEventForExport } from './redact-export'
import type { ScopeForSanitize } from './scope-sanitize'

// Per-target Markdown walkthrough — the report skeleton an OSCP candidate, a red
// team's attack narrative, and a purple team's by-target write-up all need, and
// the thing a raw NDJSON dump is not. It is data, not a formatted PDF (the
// data-export-first direction): one `## <target>` section per host, each a
// time-ordered list of the turning points (commands with exit codes, DNS
// resolutions, loot, markers, scope violations) drawn from hostCausalChain, so
// the operator writes prose around a correct, already-assembled spine instead of
// reconstructing "what did I run on this box" from memory. Redacted like every
// export (sanitize swap always; scope masks out-of-scope content).

export interface WalkthroughSection {
  target: string
  eventCount: number
  operatorCount: number
  firstSeen: number | null
  lastSeen: number | null
  chain: RedLogEvent[]
}

function iso(ts: number | null): string {
  if (ts == null) return '—'
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function timeOnly(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19) + 'Z'
}

/** One chain event → one Markdown bullet. Kept deliberately terse; the operator
 *  adds prose. Commands are code-spanned so paths/flags survive Markdown. */
function eventLine(e: RedLogEvent): string {
  const d = e.data as Record<string, unknown>
  const sub = typeof d.subtype === 'string' ? d.subtype : ''
  const t = timeOnly(e.timestamp)
  if (e.agentType === 'shell' && (sub === 'command_start' || sub === 'command_end' || sub === 'command')) {
    const cmd = String(d.command ?? '').replace(/`/g, '´')
    const exit = sub === 'command_end' && d.exit_code != null ? ` → exit ${d.exit_code}` : ''
    return `- \`${t}\` \`$ ${cmd}\`${exit}`
  }
  if (e.agentType === 'dns' && sub === 'dns_response') {
    const name = String(d.query_name ?? d.host ?? '')
    return `- \`${t}\` **DNS** ${name} → ${e.targetId ?? String(d.host ?? '')}`
  }
  if (e.agentType === 'loot') {
    const type = String(d.loot_type ?? d.type ?? 'loot')
    const preview = d.preview ? ` — ${String(d.preview).replace(/`/g, '´').slice(0, 80)}` : ''
    return `- \`${t}\` **戰利品/loot** \`${type}\`${preview}`
  }
  if (e.agentType === 'marker') {
    const title = String(d.title ?? '').replace(/\n/g, ' ')
    const sev = d.severity ? ` (${String(d.severity)})` : ''
    return `- \`${t}\` **標記/marker** ${title}${sev}`
  }
  if (e.agentType === 'system' && sub === 'scope_violation') {
    return `- \`${t}\` **⚠ 範圍違規/scope violation** ${e.targetId ?? String(d.target ?? '')}`
  }
  return `- \`${t}\` ${e.agentType}.${sub}`
}

/** Pure Markdown formatter — no DB. Each section becomes a `## <target>` block. */
export function targetWalkthroughMarkdown(
  sections: WalkthroughSection[],
  opts: { title?: string; generatedAt?: string } = {}
): string {
  const out: string[] = []
  out.push(`# ${opts.title ?? 'RedLog target walkthrough'}`)
  if (opts.generatedAt) out.push(`\n_generated ${opts.generatedAt}_`)
  out.push(`\n${sections.length} target(s).`)
  for (const s of sections) {
    out.push(`\n## ${s.target}`)
    out.push(`\n${s.eventCount} events · ${s.operatorCount} operator(s) · ${iso(s.firstSeen)} – ${iso(s.lastSeen)}\n`)
    if (s.chain.length === 0) {
      out.push('_(no commands, loot, markers, or resolutions recorded for this target)_')
    } else {
      for (const e of s.chain) out.push(eventLine(e))
    }
  }
  return out.join('\n') + '\n'
}

/** DB-backed assembly: every target (busiest last-seen first, capped), each with
 *  its redacted causal chain, formatted to Markdown. */
export function buildTargetWalkthrough(
  opts: { scope?: ScopeForSanitize; targetLimit?: number; chainLimit?: number; generatedAt?: string } = {}
): string {
  const targetLimit = opts.targetLimit ?? 200
  const targets = aggregateTargets().slice(0, targetLimit)
  const sections: WalkthroughSection[] = targets.map((t) => {
    const c = hostCausalChain(t.target, { chainLimit: opts.chainLimit })
    return {
      target: t.target,
      eventCount: c.eventCount,
      operatorCount: c.operatorCount,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      chain: c.chain.map((e) => redactEventForExport(e, opts.scope))
    }
  })
  return targetWalkthroughMarkdown(sections, { generatedAt: opts.generatedAt })
}
