import { queryEvents } from '../core/db/events'

// Recent distinct pivot nodes for the overlay — dedup by intermediate node,
// most-recent first, capped. Lets the floating window show the live pivot chain.
export interface ActivePivot { via: string; tool: string; route?: string; ts: number }
// A pivot is only shown while it's plausibly still open. RedLog detects pivots
// from the command that creates them (ssh -D/-L/-R, chisel, ligolo…). It closes
// them on two signals, best-to-worst:
//   1. command_end for a foreground tunnel — the shell hook fires it when the
//      ssh/chisel process actually exits, so a Ctrl-C'd SOCKS tunnel drops at
//      once. Ingest records that end as a pivot row of its own (subtype
//      'closed', same command; see ingest.ts), and a backgrounded `-f`/`&` pivot,
//      whose command ends at once while the tunnel lives on, gets none.
//   2. a 30-min recency window — the fallback for backgrounded/remote pivots we
//      can't observe closing; without it a single ssh command would pin a pivot
//      to the HUD forever.
// (PID liveness isn't viable: command_start fires before the process exists, the
// hook's pid is the shell's $$, and -fN self-daemonizes — plus remote/agent-run
// pivots have no PID this host could check.)
//
// The close is read from the pivot rows, not from the shell rows around it. It
// used to be looked for in the last 120 shell rows, so sixty commands after a
// tunnel exited its close fell out of view and the tunnel came back on the HUD.
// A close is always newer than the open it ends, so in the same newest-first
// pivot window it is always seen first.
const PIVOT_ACTIVE_WINDOW_MS = 30 * 60 * 1000

export function readActivePivots(now = Date.now()): ActivePivot[] {
  const evs = queryEvents({ agentType: 'pivot', limit: 40 })
  const cutoff = now - PIVOT_ACTIVE_WINDOW_MS
  // Commands whose tunnel has exited since it was opened. Newest first, so a
  // close only hides the opens older than it: the same command run again
  // afterwards is a new tunnel.
  const closedCmds = new Set<string>()
  const seen = new Set<string>()
  const out: ActivePivot[] = []
  for (const e of evs) {
    if (e.timestamp < cutoff) continue
    const d = (e.data ?? {}) as Record<string, unknown>
    const cmd = (d.command as string) || ''
    if (d.subtype === 'closed') {
      if (cmd) closedCmds.add(cmd)
      continue
    }
    const via = (d.via as string) || ''
    if (!via || seen.has(via)) continue
    if (cmd && closedCmds.has(cmd)) continue // foreground tunnel has since exited
    seen.add(via)
    out.push({ via, tool: String(d.tool ?? 'pivot'), route: d.route as string | undefined, ts: e.timestamp })
    if (out.length >= 5) break
  }
  return out
}
