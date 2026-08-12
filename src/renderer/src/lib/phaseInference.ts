// Phase-inference seam — DESIGN-PRINCIPLES §3, the SUGGESTION layer.
//
// This module is NEVER authoritative. §3 draws a hard line: RedLog records
// facts (an operator marker, or a command that primary capture proves ran), and
// treats every *interpretation* — including "which engagement phase is this?" —
// as a suggestion. So everything this function emits is `inferred`: it is
// confidence-scored, carries the id of the event that triggered it, and is meant
// to be promoted by the operator into a real `marker` with one click. It must
// never mutate an event or be shown as ground truth (§3: dashed segment, not
// solid). Downgrade, don't assert.
//
// It is deliberately NOT an opinionated ATT&CK engine. It is a light, defensible
// "event type → phase signal" heuristic that stays conservative on purpose:
// where a mapping is weak (an untagged transfer, a page load), the confidence is
// `low`, and unrecognised event types produce nothing at all. The seam marks
// phase *boundaries* — where a phase begins — not every event inside a phase.

export type Confidence = 'low' | 'medium' | 'high'

export interface EventLike {
  id: string
  timestamp: number
  agentType: string
  data?: { subtype?: string; direction?: string }
}

export interface InferredPhase {
  ts: number
  phase: string
  confidence: Confidence
  reason: string
  /** id of the event that triggered this suggestion — the promotion anchor. */
  sourceEventId: string
}

// The signal a single event carries about the current phase. Kept separate from
// InferredPhase because ts/sourceEventId belong to the event, not the mapping.
interface PhaseSignal {
  phase: string
  confidence: Confidence
  reason: string
}

// Map one event to a phase signal, or null if the event type carries no signal.
// Conservative by construction: a value only appears here if it is defensible in
// a report, and ambiguous cases resolve to the lower-confidence reading.
function signalFor(ev: EventLike): PhaseSignal | null {
  switch (ev.agentType) {
    case 'pivot':
      // A tunnel/pivot is an unambiguous lateral-movement act — high confidence.
      return { phase: 'lateral-movement', confidence: 'high', reason: 'pivot/tunnel detected' }

    case 'file_transfer': {
      // Direction decides the phase. Treat an explicit exfil direction OR an
      // exfil-flavoured subtype as data leaving; everything else (ingress, or an
      // untagged transfer) is conservatively read as delivery.
      const dir = ev.data?.direction ?? ''
      const sub = ev.data?.subtype ?? ''
      const looksExfil = dir.includes('exfil') || sub.includes('exfil')
      if (looksExfil) {
        return { phase: 'exfil', confidence: 'medium', reason: 'outbound file transfer' }
      }
      return { phase: 'delivery', confidence: 'low', reason: 'inbound file transfer' }
    }

    case 'cleanup':
      // Anti-forensics is a distinct, high-signal act (NIST SP 800-86).
      return { phase: 'anti-forensics', confidence: 'high', reason: 'cleanup/anti-forensics action' }

    case 'credential_use':
    case 'loot':
      return {
        phase: 'credential-access',
        confidence: 'medium',
        reason: 'credential use or loot detected'
      }

    case 'scanner':
    case 'dns':
    case 'http_navigation':
      // Weak, common signals — recon at low confidence only.
      return { phase: 'recon', confidence: 'low', reason: 'scan/dns/navigation activity' }

    default:
      return null
  }
}

/**
 * Derive phase-boundary suggestions from a list of events (§3 suggestion layer).
 *
 * Processes events in ascending ts order (the input is sorted first, so callers
 * need not pre-sort). Collapses adjacent runs of the same phase to a single
 * boundary — we mark where a phase *starts*, not every event inside it — so a
 * suggestion's ts and sourceEventId point at the FIRST event of its run. A phase
 * that recurs after a different phase intervenes is a new, kept boundary.
 *
 * Empty input → []. Nothing here is authoritative; see the file header.
 */
export function inferPhaseSuggestions(events: EventLike[]): InferredPhase[] {
  if (events.length === 0) return []

  // Sort a copy — never mutate the caller's array. Stable enough for ties: we
  // only need monotonic ts ordering to find boundaries.
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

  const out: InferredPhase[] = []
  let prevPhase: string | null = null

  for (const ev of sorted) {
    const signal = signalFor(ev)
    if (signal === null) continue // unmapped event type: no suggestion

    // Adjacent de-dup: only the first event of a run of the same phase becomes a
    // boundary. An unmapped event between two same-phase events does not break
    // the run — prevPhase is untouched when we `continue` above.
    if (signal.phase === prevPhase) continue

    out.push({
      ts: ev.timestamp,
      phase: signal.phase,
      confidence: signal.confidence,
      reason: signal.reason,
      sourceEventId: ev.id
    })
    prevPhase = signal.phase
  }

  return out
}
