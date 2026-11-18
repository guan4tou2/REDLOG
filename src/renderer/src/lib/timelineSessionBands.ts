// Session-band segment builder, lifted from Timeline.tsx so the layout logic
// can be tested independently.

export interface SessionBand {
  id: string
  x0: number
  x1: number
  /** The band's start and end times; for an open pause, the end is now. */
  from: number
  to: number
  /** A pause with no resume yet. */
  open: boolean
  label: string
  kind: 'term' | 'paused'
  row: number
}

interface MinimalEvent {
  id: string
  timestamp: number
  agentType: string
  data?: Record<string, unknown>
}

export interface SessionBandLabels {
  termLabel: (termIdPrefix: string) => string
  pausedLabel: string
}

/**
 * Derive session-band segments from `shell.session_end` +
 * `system.recording_paused`/`recording_resumed` pairs.
 *
 * The greedy interval-colouring pass at the end staggers overlapping labels
 * so two terminals open at the same time don't stack unreadably.
 */
export function buildSessionBands(
  events: readonly MinimalEvent[],
  toX: (ts: number) => number,
  labels: SessionBandLabels,
  timeEnd: number,
  labelClearancePx = 54
): SessionBand[] {
  const bands: SessionBand[] = []

  for (const e of events) {
    if (e.agentType === 'shell' && e.data?.subtype === 'session_end') {
      const tid = (e.data?.terminalId as string | undefined) ?? ''
      const durMs = Number(e.data?.durationMs)
      const endTs = e.timestamp
      const startTs = Number.isFinite(durMs) && durMs > 0 ? endTs - durMs : endTs
      bands.push({
        id: `term-${e.id}`,
        x0: toX(startTs),
        x1: toX(endTs),
        from: startTs,
        to: endTs,
        open: false,
        label: labels.termLabel(tid.slice(0, 4)),
        kind: 'term',
        row: 0
      })
    }
  }

  let openPause: MinimalEvent | null = null
  for (const e of events) {
    if (e.agentType !== 'system') continue
    const sub = e.data?.subtype as string | undefined
    if (sub === 'recording_paused') {
      if (openPause) {
        bands.push({
          id: `paused-${openPause.id}`,
          x0: toX(openPause.timestamp),
          x1: toX(e.timestamp),
          from: openPause.timestamp,
          to: e.timestamp,
          open: false,
          label: labels.pausedLabel,
          kind: 'paused',
          row: 0
        })
      }
      openPause = e
    } else if (sub === 'recording_resumed' && openPause) {
      bands.push({
        id: `paused-${openPause.id}`,
        x0: toX(openPause.timestamp),
        x1: toX(e.timestamp),
        from: openPause.timestamp,
        to: e.timestamp,
        open: false,
        label: labels.pausedLabel,
        kind: 'paused',
        row: 0
      })
      openPause = null
    }
  }
  if (openPause) {
    const to = Math.min(Date.now(), timeEnd)
    bands.push({
      id: `paused-${openPause.id}-open`,
      x0: toX(openPause.timestamp),
      x1: toX(to),
      from: openPause.timestamp,
      to,
      open: true,
      label: labels.pausedLabel,
      kind: 'paused',
      row: 0
    })
  }

  // Greedy interval colouring: lowest available row per band.
  const rowEnds: number[] = []
  for (const b of [...bands].sort((p, q) => p.x0 - q.x0)) {
    let row = rowEnds.findIndex((end) => end <= b.x0)
    if (row === -1) { row = rowEnds.length; rowEnds.push(0) }
    rowEnds[row] = Math.max(b.x1, b.x0 + labelClearancePx)
    b.row = row
  }
  return bands
}

/** Milliseconds of recording pause that fall inside `[lo, hi]`. */
export function pausedMsWithin(bands: readonly SessionBand[], lo: number, hi: number): number {
  let ms = 0
  for (const b of bands) {
    if (b.kind !== 'paused') continue
    ms += Math.max(0, Math.min(b.to, hi) - Math.max(b.from, lo))
  }
  return ms
}
