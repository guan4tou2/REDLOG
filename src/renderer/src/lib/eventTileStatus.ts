// The Dashboard event tile's sub-line. It speaks about the chain only when
// something is wrong with it: a sound chain used to fill the line with
// "chain in sync · <the number above> · ⚓ 22m · sampled 2m ago" — four facts,
// none with anything to do, two of them ticking.

type Translate = (key: string, vars?: Record<string, string | number>) => string

export interface EventTileInput {
  eventCount: number
  chainLen: number
  lastAnchor: { createdAt: number; status: string } | null
  sampleBroken: { eventTimestamp?: number } | undefined
  now: number
}

export function eventTileStatus(r: EventTileInput, t: Translate): {
  sub: string | undefined
  tone: 'cyan' | 'amber' | 'red'
} {
  const notes: string[] = []
  let tone: 'cyan' | 'amber' | 'red' = 'cyan'

  // A drift would itself be a tamper signal.
  if (r.chainLen !== r.eventCount) {
    notes.push(t('dashboard.chainDrift', { chain: r.chainLen, events: r.eventCount }))
    tone = 'red'
  }

  // v0.6.88 P2-B: <2h is normal and says nothing, <24h amber, 24h+ red (the
  // OTS calendar cadence is hourly — beyond a day the anchor loop has been
  // broken for a while).
  if (r.lastAnchor) {
    const ageHr = Math.floor((r.now - r.lastAnchor.createdAt) / 3600000)
    if (r.lastAnchor.status === 'failed') {
      notes.push(t('dashboard.anchorFailed'))
      tone = 'red'
    } else if (ageHr >= 2) {
      notes.push(t('dashboard.anchorStale', { age: ageHr < 24 ? `${ageHr}h` : `${Math.floor(ageHr / 24)}d` }))
      tone = ageHr >= 24 || tone === 'red' ? 'red' : 'amber'
    }
  }

  // A broken sample forces the tile red — the CaptureHealthCard also flips to
  // dark, so the operator gets two independent signals. The broken row's own
  // age lets them tell a stale historical row from a fresh regression.
  if (r.sampleBroken) {
    const ets = r.sampleBroken.eventTimestamp
    let age = ''
    if (typeof ets === 'number' && ets > 0) {
      const days = Math.floor((r.now - ets) / 86400000)
      const hrs = Math.floor((r.now - ets) / 3600000)
      age = days >= 1 ? ` ${t('dashboard.sampleAgeDays', { n: days })}`
        : hrs > 0 ? ` ${t('dashboard.sampleAgeHours', { n: hrs })}`
          : ` ${t('dashboard.sampleFresh')}`
    }
    notes.push(`${t('dashboard.sampleBroken')}${age}`)
    tone = 'red'
  }

  return { sub: notes.length > 0 ? notes.join(' · ') : undefined, tone }
}
