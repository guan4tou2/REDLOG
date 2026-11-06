import type { PluginStatus } from '../../../core/plugins/types'
import type { OfficialAgentPlugin } from '../../../core/plugins/official-agents'

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

/** The catalog side of an official integration (`plugins:officialAgents`). */
export interface OfficialInfo {
  agentKind: string
  state: OfficialAgentPlugin['state']
  error?: string
  installationId?: string
}

/** What main answers from `plugins:list` (src/main/ipc/plugins.ts). */
export interface PluginView {
  officialAgent?: boolean
  /** Spec 066: present when the row is an official integration. */
  official?: OfficialInfo
  /** Spec 066: no loaded plugin is behind this row (not installed, or the
   *  directory is in conflict). Trust and effect do not apply — it is not
   *  "disabled", it is not there. */
  notLoaded?: boolean
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
  if (p.official?.state === 'conflict') out.push({ kind: 'official-conflict', labelKey: 'plugins.issue.officialConflict' })
  if (p.official?.state === 'error') out.push({ kind: 'official-error', labelKey: 'plugins.issue.officialError' })
  if (p.official?.state === 'update-available') out.push({ kind: 'official-update', labelKey: 'plugins.issue.officialUpdate' })
  if (p.status === 'error') out.push({ kind: 'error', labelKey: 'plugins.issue.error' })
  if (p.status === 'hash-changed') out.push({ kind: 'hash-changed', labelKey: 'plugins.issue.hashChanged' })
  if (p.status === 'needs-consent') out.push({ kind: 'needs-consent', labelKey: 'plugins.issue.needsConsent' })
  if (p.apiAhead === true) out.push({ kind: 'api-ahead', labelKey: 'plugins.issue.apiAhead' })
  if (effectGroups(p).some((g) => g.waiting === true || g.rejected.length > 0)) out.push({ kind: 'partially-effective', labelKey: 'plugins.issue.partiallyEffective' })
  if (p.profilesError) out.push({ kind: 'profiles-stale', labelKey: 'plugins.issue.profilesStale' })
  return out
}

export const needsAttention = (p: PluginView): boolean => attentionIssues(p).length > 0

/** Where a plugin comes from, as the list names it. An official integration is
 *  one RedLog installs and updates (Spec 066); a bundled pack ships inside the
 *  app; everything else was placed in the plugins folder by the operator. */
export type PluginKind = 'official' | 'builtin' | 'user'
export const pluginKind = (p: PluginView): PluginKind => p.official ? 'official' : p.source === 'bundled' ? 'builtin' : 'user'

/** The list's filter tabs. «Installed» means there is a plugin behind the row:
 *  a not-installed official integration is listed but is not installed. */
export type PluginFilter = 'all' | 'installed' | 'official' | 'attention'
export function matchesPluginFilter(p: PluginView, filter: PluginFilter): boolean {
  switch (filter) {
    case 'installed': return p.notLoaded !== true
    case 'official': return pluginKind(p) !== 'user'
    case 'attention': return needsAttention(p)
    default: return true
  }
}

/** One colour for the row's dot. It says «is something wrong», not «is it
 *  recording»: a plugin the operator switched off, or an integration not
 *  installed yet, is idle rather than faulty. */
export type PluginTone = 'ok' | 'warn' | 'bad' | 'idle'
export function pluginTone(p: PluginView): PluginTone {
  if (p.status === 'error' || p.official?.state === 'error' || p.official?.state === 'conflict') return 'bad'
  if (needsAttention(p)) return 'warn'
  if (p.notLoaded === true || p.status === 'disabled') return 'idle'
  return 'ok'
}

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

/** The thin per-axis view. Install/project/health stay explicit rather than
 *  merging into the trust status: «loaded» is not a verdict on the others. */
export interface PluginViewModel {
  pluginId: string
  name: string
  searchText: string
  issues: PluginIssue[]
  trust: {
    /** false when no plugin is loaded behind the row (not installed). */
    applicable: boolean
    /** An official integration is switched on again by restoring it (install),
     *  which main audits; `plugins:setEnabled` refuses it by design. */
    canToggle: boolean
    status: PluginStatus
    needsConsent: boolean
    cannotBeTrusted: boolean
    canRevoke: boolean
  }
  effect: { groups: PluginEffectGroup[]; unknown: boolean; apiAhead: boolean }
  install: {
    origin: 'bundled' | 'user'
    managedBy: 'officialIntegration' | 'pluginFolder'
    official?: { agentKind: string; state: OfficialAgentPlugin['state']; error?: string }
  }
}

export function pluginViewModel(p: PluginView, describe: (p: PluginView) => string): PluginViewModel {
  const needsConsent = p.status === 'needs-consent' || p.status === 'hash-changed'
  return {
    pluginId: p.id,
    name: p.name,
    searchText: pluginSearchText(p, describe),
    issues: attentionIssues(p),
    trust: {
      applicable: p.notLoaded !== true,
      canToggle: p.notLoaded !== true && !p.official,
      status: p.status,
      needsConsent,
      cannotBeTrusted: cannotBeTrusted(p),
      canRevoke: (p.tier === 'privileged' || p.needsApproval === true) && p.status === 'active'
    },
    effect: { groups: effectGroups(p), unknown: p.report === null, apiAhead: p.apiAhead === true },
    install: {
      origin: p.source,
      managedBy: p.official ? 'officialIntegration' : 'pluginFolder',
      ...(p.official ? { official: { agentKind: p.official.agentKind, state: p.official.state, error: p.official.error } } : {})
    }
  }
}

const officialInfo = (c: OfficialAgentPlugin): OfficialInfo =>
  ({ agentKind: c.agentKind, state: c.state, error: c.error, installationId: c.installationId })

/** Merge the official-integration catalog into the loaded-plugin list by
 *  `pluginId`. A not-installed integration has no loaded plugin, so it gets a
 *  stub row (`notLoaded`) rather than vanishing or reading as "disabled". The
 *  ordinary plugins keep their identity and every existing field (FR-006). */
export function mergeOfficialCatalog(plugins: PluginView[], catalog: OfficialAgentPlugin[]): PluginView[] {
  const byId = new Map(catalog.map((c) => [c.pluginId, c]))
  const loaded = new Set(plugins.map((p) => p.id))
  const merged = plugins.map((p) => {
    const c = byId.get(p.id)
    return c ? { ...p, officialAgent: true, official: officialInfo(c) } : p
  })
  for (const c of catalog) {
    if (loaded.has(c.pluginId)) continue
    merged.push({
      id: c.pluginId, name: c.name, version: '', description: '', author: 'RedLog', source: 'bundled', tier: 'declarative',
      status: 'disabled', capabilities: [], contributes: [], report: null,
      officialAgent: true, official: officialInfo(c), notLoaded: true
    })
  }
  return merged
}

/** What the operator has done for THIS project, kept apart from health: an
 *  integration can be installed and healthy while this project never opted in. */
export type OfficialProjectLevel = 'notInstalled' | 'unavailable' | 'installedNotEnabled' | 'recording' | 'unknown'

export function officialProjectLevel(
  p: PluginView,
  source: { enabled?: boolean; installationId?: string } | undefined
): OfficialProjectLevel {
  const o = p.official
  if (!o) return 'unknown'
  if (o.state === 'not-installed') return 'notInstalled'
  if (o.state === 'conflict' || o.state === 'error') return 'unavailable'
  if (source === undefined) return 'unknown'
  const authorized = !!o.installationId && source.installationId === o.installationId
  return source.enabled === true && authorized && p.status === 'active' ? 'recording' : 'installedNotEnabled'
}

export type OfficialHealth =
  | { kind: 'unknown' }
  | { kind: 'error'; message: string }
  | { kind: 'received'; at: number }
  | { kind: 'inactive' }
  | { kind: 'waiting' }

/** Capture health from the shared snapshot. A failed read is `unknown` — the
 *  previous verdict is never reused — and "nothing received" is only a fault
 *  when the source reports its own error: a source that is not installed or not
 *  enabled for this project is not expected to be delivering. */
export function officialHealth(
  p: PluginView,
  level: OfficialProjectLevel,
  snapshot: { status: 'ok' | 'unknown'; source?: { lastEventAt: number | null; lastError?: { message: string } } }
): OfficialHealth {
  if (snapshot.status === 'unknown') return { kind: 'unknown' }
  const inactive = level === 'notInstalled' || level === 'unavailable' || level === 'installedNotEnabled'
  const s = snapshot.source
  if (!s) return inactive ? { kind: 'inactive' } : { kind: 'unknown' }
  if (s.lastError) return { kind: 'error', message: s.lastError.message }
  if (s.lastEventAt !== null) return { kind: 'received', at: s.lastEventAt }
  return inactive || !p.official ? { kind: 'inactive' } : { kind: 'waiting' }
}