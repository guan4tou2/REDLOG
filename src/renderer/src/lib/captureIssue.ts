import { settingsTarget } from './navigation'

// Where the capture issue's "go there" leads.
//
// It used to be the dashboard, always — which is where the issue list is
// drawn, so from there the link went nowhere. Then it was the failing source's
// own settings when exactly one source failed, and the dashboard again when
// two did: the worse the situation, the less the screen offered.
//
// A partial verdict means one or more sources tried and failed, and the place
// to act is the capture sources page, where every source but the two core ones
// has a row, landed on by `data-source-id`. That mechanism lands on one row, so
// with several failures it is the first in the snapshot's order that has a row
// there; the snapshot does not grade one failure above another, so this is
// order, not severity. Only that row is landed on: the page does not mark the
// other failing rows, which the dashboard's capture card lists.
// The two core sources are configured on their own pages and have no row on
// the capture sources page: they are the answer only when nothing else is
// failing. A dark verdict names no source and stays on the dashboard, whose
// capture card shows the whole picture.

interface CaptureReading {
  verdict: 'healthy' | 'partial' | 'dark'
  sources: ReadonlyArray<{ id: string; state: string }>
  managedHttpProxy?: { state: string } | null
}

/** The two core sources are configured on their own Settings pages; every
 *  other source has a row on the capture sources page. */
const CORE_SOURCES: ReadonlySet<string> = new Set(['terminal', 'mitmproxy'])

function sourceTarget(id: string): string {
  if (id === 'terminal') return settingsTarget('hooks')
  if (id === 'mitmproxy') return settingsTarget('browser')
  return settingsTarget('captureControl', { source: id })
}

export function captureIssueView(h: CaptureReading): string {
  if (h.verdict !== 'partial') return 'dashboard'
  const failing = h.sources.filter((s) => s.state === 'error').map((s) => s.id)
  // A proxy that could not start is HTTP capture failing, whatever the
  // mitmproxy row's own state says.
  if (h.managedHttpProxy?.state === 'failed' && !failing.includes('mitmproxy')) failing.push('mitmproxy')
  if (failing.length === 0) return 'dashboard'
  return sourceTarget(failing.find((id) => !CORE_SOURCES.has(id)) ?? failing[0])
}
