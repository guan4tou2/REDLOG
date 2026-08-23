// Group HTTP flows into the shape docs/DESIGN-core-and-capture.md §3 asks for.
//
// §3: a single connection is a **point**; a scan or bulk operation is a
// **span** covering its duration; and in both cases *only the activity is
// listed* — the connections it produced are its contents, reachable by
// reference, never rendered individually.
//
// The HTTP History panel arrived rendering 5000 flows as 5000 rows, which is
// Burp's information architecture. Burp is a tool for *driving* traffic, where
//每 one request is a thing you are about to modify and resend. This is a
// record of an engagement, where one request is almost never the unit of
// interest: "I ran a directory brute-force against x" is, and it is one line
// whether it made four requests or forty thousand.
//
// Nothing is dropped. Expanding a group still lists its flows — the change is
// which level the eye lands on first.

export interface FlowLike {
  flowId: string
  host: string
  method: string
  url: string
  status: number | null
  timestamp: number
  durationMs: number | null
  /** First `_causes` entry on the request event, when the traffic has a parent. */
  causeEventId?: string | null
}

export interface Activity<F extends FlowLike = FlowLike> {
  /** Stable key: the parent command's event id, or host + first timestamp. */
  id: string
  host: string
  /** The command that produced this traffic, when the record links one. */
  causeEventId: string | null
  flows: F[]
  startMs: number
  /** Last flow's start plus its duration — the end of the span. */
  endMs: number
  /** §3's distinction. One flow with no parent is a point; the rest are spans. */
  kind: 'point' | 'span'
  methods: string[]
  /** Count per leading status digit, for a one-glance shape of the result. */
  statusBuckets: Record<string, number>
}

/**
 * How long a quiet stretch has to be before the next request counts as a new
 * activity rather than more of the same one.
 *
 * Four seconds is chosen against the failure that matters: a scanner's own
 * pacing — a rate limit, a slow target, a retry — must not split one run into
 * a dozen entries, because that would recreate the wall of rows this exists to
 * remove. Merging two genuinely separate actions is the cheaper mistake: they
 * are still both there, one level down, and the operator can see the gap in
 * the timestamps.
 */
const IDLE_GAP_MS = 4000

export function groupFlows<F extends FlowLike>(flows: F[]): Array<Activity<F>> {
  if (flows.length === 0) return []
  const sorted = [...flows].sort((a, b) => a.timestamp - b.timestamp)

  const out: Array<Activity<F>> = []
  let current: Activity<F> | null = null

  const flush = (): void => {
    if (!current) return
    // A single flow with no parent command is §3's point. Everything else —
    // several flows, or one flow a command is known to have produced — reads
    // as a span, because the interesting extent is the activity's, not the
    // connection's.
    current.kind = current.flows.length === 1 && !current.causeEventId ? 'point' : 'span'
    current.methods = [...new Set(current.flows.map((f) => f.method).filter(Boolean))].sort()
    out.push(current)
    current = null
  }

  for (const f of sorted) {
    const cause = f.causeEventId ?? null
    const continues =
      current !== null &&
      // A parent command is a hard boundary in both directions: traffic with a
      // known cause belongs to that cause and nothing else, and traffic
      // without one never joins a group that has one.
      current.causeEventId === cause &&
      (cause !== null || (current.host === f.host && f.timestamp - lastStart(current) <= IDLE_GAP_MS))

    if (!continues) {
      flush()
      current = {
        id: cause ?? `${f.host}:${f.timestamp}`,
        host: f.host,
        causeEventId: cause,
        flows: [],
        startMs: f.timestamp,
        endMs: f.timestamp,
        kind: 'point',
        methods: [],
        statusBuckets: {}
      }
    }
    current!.flows.push(f)
    current!.endMs = Math.max(current!.endMs, f.timestamp + (f.durationMs ?? 0))
    if (f.status !== null) {
      const b = String(f.status)[0]
      current!.statusBuckets[b] = (current!.statusBuckets[b] ?? 0) + 1
    }
  }
  flush()
  return out
}

function lastStart<F extends FlowLike>(a: Activity<F>): number {
  return a.flows.length ? a.flows[a.flows.length - 1].timestamp : a.startMs
}

/** Hosts touched by an activity, for the rare group that spans more than one. */
export function activityHosts<F extends FlowLike>(a: Activity<F>): string[] {
  return [...new Set(a.flows.map((f) => f.host).filter(Boolean))]
}
