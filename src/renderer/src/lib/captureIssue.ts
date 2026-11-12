import { settingsTarget } from './navigation'

// Where the capture issue's "go there" leads.
//
// It used to be the dashboard, always — which is where the issue list is
// drawn, so from there the link went nowhere. A partial verdict means one or
// more sources tried and failed; when it is exactly one, the place to act is
// that source's own settings. Anything else (a dark verdict, several failures)
// has no single place, and the dashboard's capture card is where the whole
// picture is.
//
// No ranking: the snapshot does not grade one failure above another, so two
// failures are two, and this does not pick between them.

interface CaptureReading {
  verdict: 'healthy' | 'partial' | 'dark'
  sources: ReadonlyArray<{ id: string; state: string }>
  managedHttpProxy?: { state: string } | null
}

/** The two core sources are configured on their own Settings pages; every
 *  other source has a row on the capture sources page. */
function sourceTarget(id: string): string {
  if (id === 'terminal') return settingsTarget('hooks')
  if (id === 'mitmproxy') return settingsTarget('browser')
  return settingsTarget('captureControl', { source: id })
}

export function captureIssueView(h: CaptureReading): string {
  if (h.verdict !== 'partial') return 'dashboard'
  const failing = new Set(h.sources.filter((s) => s.state === 'error').map((s) => s.id))
  // A proxy that could not start is HTTP capture failing, whatever the
  // mitmproxy row's own state says.
  if (h.managedHttpProxy?.state === 'failed') failing.add('mitmproxy')
  if (failing.size !== 1) return 'dashboard'
  return sourceTarget([...failing][0])
}
