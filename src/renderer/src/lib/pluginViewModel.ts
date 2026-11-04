import type { PluginStatus } from '../../../core/plugins/types'

// Plugin page view model — pure, jsdom-free.
//
// Spec 065: the settings→plugins page lists every plugin and answers "does
// what I installed actually work". The shape main returns (PluginView below,
// moved out of PluginsPanel.tsx) is flattened here into five axes — install,
// trust, effect, project, health — so the UI never merges them into a single
// status colour, which would make "loaded" look like "everything works".
// `report === null` means "no diagnosis yet", not "everything was accepted".

export interface PluginTerminalProfile {
  name: string
  mode: 'native' | 'pty' | 'relayed'
  executables: string[]
  reason: string
}
export interface PluginCaptureInstall { name: string; installMethod: string }

/** What main answers from `plugins:list` (src/main/ipc/plugins.ts). */
export interface PluginView {
  officialAgent?: boolean
  id: string
  name: string
  version: string
  description: string
  author: string
  source: 'bundled' | 'user'
  tier: 'declarative' | 'privileged'
  /** the plugin takes effect only once the operator approves its content:
   *  code (privileged), or terminal profiles, which run nothing */
  needsApproval?: boolean
  status: PluginStatus
  capabilities: string[]
  contributes: string[]
  terminalProfiles?: PluginTerminalProfile[]
  captureInstalls?: PluginCaptureInstall[]
  /** why the shell's profiles could not be brought up to date, the same on
   *  every row; null when they were */
  profilesError?: string | null
  error?: string
  /** manifest targets a newer plugin API than this RedLog implements */
  apiAhead?: boolean
  report?: {
    lootPatterns?: { accepted: number; rejected: Array<{ name: string; reason: string }> }
    redaction?: { accepted: number; rejected: Array<{ list: string; entry: string; reason: string }> }
    tailers?: { state: 'accepted' | 'rejected'; reason?: string }
    targetExtractors?: { accepted: number; rejected: Array<{ name: string; reason: string }> }
    commandTags?: { accepted: number; rejected: Array<{ name: string; reason: string }> }
    eventTypes?: { accepted: number; rejected: Array<{ name: string; reason: string }> }
    capture?: { accepted: number; rejected: Array<{ name: string; reason: string }>; waiting?: boolean }
    terminalProfiles?: { accepted: number; rejected: Array<{ name: string; reason: string }>; waiting?: boolean }
  } | null
}

/** One contribution group of the report, normalised so the detail view can
 *  render every group the same way (redaction rejects carry list/entry; the
 *  rest carry name — both land as one titled line + reason). */
export interface PluginEffectGroup {
  key: string
  labelKey: string
  accepted: number
  waiting?: boolean
  rejected: Array<{ title: string; reason: string }>
}

/** A reason a plugin needs attention. `kind` for dedupe, `labelKey` for the
 *  single most important line the list and the "needs attention" filter show. */
export interface PluginIssue {
  kind: string
  labelKey: string
}

export function effectGroups(p: PluginView): PluginEffectGroup[] {
  const r = p.report
  if (!r) return []
  const rejects = (xs: Array<{ name: string; reason: string }> | undefined): Array<{ title: string; reason: string }> =>
    (xs ?? []).map((x) => ({ title: x.name, reason: x.reason }))
  const groups: PluginEffectGroup[] = []
  if (r.lootPatterns) groups.push({ key: 'loot', labelKey: 'plugins.results.loot', accepted: r.lootPatterns.accepted, rejected: rejects(r.lootPatterns.rejected) })
  if (r.targetExtractors) groups.push({ key: 'targetExtractors', labelKey: 'plugins.results.targetExtractors', accepted: r.targetExtractors.accepted, rejected: rejects(r.targetExtractors.rejected) })
  if (r.commandTags) groups.push({ key: 'commandTags', labelKey: 'plugins.results.commandTags', accepted: r.commandTags.accepted, rejected: rejects(r.commandTags.rejected) })
  if (r.eventTypes) groups.push({ key: 'eventTypes', labelKey: 'plugins.results.eventTypes', accepted: r.eventTypes.accepted, rejected: rejects(r.eventTypes.rejected) })
  if (r.capture) groups.push({ key: 'capture', labelKey: 'plugins.results.capture', accepted: r.capture.accepted, waiting: r.capture.waiting, rejected: rejects(r.capture.rejected) })
  if (r.terminalProfiles) groups.push({ key: 'terminalProfiles', labelKey: 'plugins.results.terminalProfiles', accepted: r.terminalProfiles.accepted, waiting: r.terminalProfiles.waiting, rejected: rejects(r.terminalProfiles.rejected) })
  if (r.redaction) groups.push({
    key: 'redaction',
    labelKey: 'plugins.results.redaction',
    accepted: r.redaction.accepted,
    rejected: r.redaction.rejected.map((x) => ({ title: `${x.list}: ${x.entry}`, reason: x.reason }))
  })
  if (r.tailers) {
    if (r.tailers.state === 'rejected') {
      groups.push({ key: 'tailers', labelKey: 'plugins.results.tailerRejected', accepted: 0, rejected: r.tailers.reason ? [{ title: '', reason: r.tailers.reason }] : [] })
    } else {
      groups.push({ key: 'tailers', labelKey: 'plugins.results.tailerAccepted', accepted: 1, rejected: [] })
    }
  }
  return groups
}

/** Every currently-true issue for the plugin, most important first. The list
 *  shows the first one; the detail shows all of them. */
export function attentionIssues(p: PluginView): PluginIssue[] {
  const out: PluginIssue[] = []
  if (p.status === 'error') out.push({ kind: 'error', labelKey: 'plugins.issue.error' })
  if (p.status === 'hash-changed') out.push({ kind: 'hash-changed', labelKey: 'plugins.issue.hashChanged' })
  if (p.status === 'needs-consent') out.push({ kind: 'needs-consent', labelKey: 'plugins.issue.needsConsent' })
  if (p.apiAhead === true) out.push({ kind: 'api-ahead', labelKey: 'plugins.issue.apiAhead' })
  if (effectGroups(p).some((g) => g.waiting === true || g.rejected.length > 0)) out.push({ kind: 'partially-effective', labelKey: 'plugins.issue.partiallyEffective' })
  if (p.profilesError) out.push({ kind: 'profiles-stale', labelKey: 'plugins.issue.profilesStale' })
  return out
}

export const needsAttention = (p: PluginView): boolean => attentionIssues(p).length > 0

/** A user plugin whose only code is a tailer is refused whatever the operator
 *  agrees to; so is a plugin with nothing left to approve. */
export function cannotBeTrusted(p: PluginView): boolean {
  const tailerRefused = p.source === 'user' && p.report?.tailers?.state === 'rejected'
  return tailerRefused && !(p.terminalProfiles?.length) && !(p.captureInstalls?.length)
}

/** Everything the search box may match against. `describe` applies the
 *  translated line for builtin packs, so a Chinese search hits them too. */
export function pluginSearchText(p: PluginView, describe: (p: PluginView) => string): string {
  return [
    p.name, p.id, p.author, p.version, p.tier, describe(p),
    ...p.capabilities, ...p.contributes
  ].filter(Boolean).join(' ').toLowerCase()
}

export function matchesQuery(searchText: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => searchText.includes(term))
}

/** The thin per-axis view. Install/project/health stay explicit rather than
 *  merging into the trust status: «loaded» is not a verdict on the others. */
export interface PluginViewModel {
  pluginId: string
  name: string
  searchText: string
  issues: PluginIssue[]
  trust: {
    status: PluginStatus
    needsConsent: boolean
    cannotBeTrusted: boolean
    canRevoke: boolean
  }
  effect: { groups: PluginEffectGroup[]; unknown: boolean; apiAhead: boolean }
  install: { origin: 'bundled' | 'user'; managedBy: 'agentSources' | 'pluginFolder' }
  project: { applicable: false }
  health: { applicable: false }
}

export function pluginViewModel(p: PluginView, describe: (p: PluginView) => string): PluginViewModel {
  const needsConsent = p.status === 'needs-consent' || p.status === 'hash-changed'
  return {
    pluginId: p.id,
    name: p.name,
    searchText: pluginSearchText(p, describe),
    issues: attentionIssues(p),
    trust: {
      status: p.status,
      needsConsent,
      cannotBeTrusted: cannotBeTrusted(p),
      canRevoke: (p.tier === 'privileged' || p.needsApproval === true) && p.status === 'active'
    },
    effect: { groups: effectGroups(p), unknown: p.report === null, apiAhead: p.apiAhead === true },
    install: { origin: p.source, managedBy: p.officialAgent === true ? 'agentSources' : 'pluginFolder' },
    project: { applicable: false },
    health: { applicable: false }
  }
}