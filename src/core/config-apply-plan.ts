// What has to happen when a project's config becomes the one in force.
//
// Opening a project, a Settings save, a target added from the Targets view, the
// current-target switch, a plugin turned on or off and a change to the shared
// hook exclusions all make a config "current". Each used to do its own subset of
// the work, and a save re-ran every reconfigure there is: changing a loot rule
// or the HUD stopped and restarted the AI transcript tailers (#686 was the
// symptom), re-seeded the file, process and connection monitors,
// re-armed the screenshot timer and fired an external IP lookup.
//
// This module is the decision and nothing else: given the config that was last
// applied and the one about to be, which subsystems need touching. It is pure.
// `src/main/config-apply.ts` runs the answer.
//
// The rule is conservative. A subsystem is reconfigured when any config path it
// reads changed. A changed path that nothing below claims — a field added later
// and never classified — reconfigures EVERYTHING, so forgetting to extend the
// map costs a restart, never a stale setting.

import { CAPTURE_PACKS, packOfMember, type PackMemberId } from './capture-packs'
import type { RedLogConfig } from './config'

export type ConfigApplyReason =
  /** First application after a project opens. No previous config: all of it. */
  | 'open'
  /** Settings / CaptureHealth / Targets ▸ add to scope / the API's config write. */
  | 'save'
  /** A pack or AI-integration plugin was enabled, disabled or (un)installed. */
  | 'plugins-changed'
  /** The machine-wide hook exclusions (`~/.redlog/hooks.json`) changed. */
  | 'hook-config'
  /** project:create seeds a NEW project's file. Another project may be open:
   *  nothing may be applied to it. The open that follows applies the new one. */
  | 'create'
  /** The title bar's current-target switch. */
  | 'target-context'

export type ConfigApplyStep =
  | 'ingestActiveTarget'
  | 'audit'
  | 'wifiName'
  | 'alertRuntime'
  | 'screenshot'
  | 'captureHealth'
  | 'managedProxy'
  | 'scopeRecompute'
  | 'terminal'
  | 'lootDetector'
  | 'fileWatcherOptions'
  | 'connectionMonitorOptions'
  | 'processMonitorOptions'
  | 'packFileWatcher'
  | 'packConnectionMonitor'
  | 'packProcessMonitor'
  | 'packPowershellTranscript'
  | 'agentTailer'
  | 'redaction'
  | 'vpnAdapters'
  // Open only: the identity these sources record under. A save never changes
  // it (operator changes reach the sources through the shared `open` object).
  | 'powershellTranscriptIdentity'
  | 'agentTailerHost'

/** Work at project open that is not a config apply but has to sit between
 *  two of its steps. The executor's caller supplies them. */
export type ConfigApplyHook = 'resetProjectCaches' | 'loadPlugins' | 'wireTerminalIngest' | 'startProjectServices'

export type ConfigApplyEntry = { step: ConfigApplyStep } | { hook: ConfigApplyHook }

/** Project open, in the order `startProjectResources` ran it before this
 *  module existed (pinned by test/config-apply.test.ts's golden list). The
 *  hooks are where the open does its own work in between: plugins load after
 *  loot and redaction so their contributions layer on top, and the capture
 *  packs run after the plugins are listed. */
export const OPEN_SEQUENCE: readonly ConfigApplyEntry[] = [
  { step: 'wifiName' },
  { step: 'screenshot' },
  { hook: 'resetProjectCaches' },
  { step: 'alertRuntime' },
  { step: 'lootDetector' },
  { step: 'captureHealth' },
  { step: 'redaction' },
  { hook: 'loadPlugins' },
  { step: 'vpnAdapters' },
  { step: 'terminal' },
  { hook: 'wireTerminalIngest' },
  { step: 'ingestActiveTarget' },
  { hook: 'startProjectServices' },
  { step: 'fileWatcherOptions' },
  { step: 'connectionMonitorOptions' },
  { step: 'powershellTranscriptIdentity' },
  { step: 'processMonitorOptions' },
  { step: 'agentTailerHost' },
  { step: 'packFileWatcher' },
  { step: 'packConnectionMonitor' },
  { step: 'packProcessMonitor' },
  { step: 'packPowershellTranscript' },
  { step: 'agentTailer' }
]

/** Every later application, in the order config:save ran them. A plan is a
 *  subset of this, in this order. */
export const APPLY_ORDER: readonly ConfigApplyStep[] = [
  'ingestActiveTarget',
  'audit',
  'wifiName',
  'alertRuntime',
  'screenshot',
  'captureHealth',
  'managedProxy',
  'scopeRecompute',
  'terminal',
  'lootDetector',
  'fileWatcherOptions',
  'connectionMonitorOptions',
  'processMonitorOptions',
  'packFileWatcher',
  'packConnectionMonitor',
  'packProcessMonitor',
  'packPowershellTranscript',
  'agentTailer',
  'redaction',
  'vpnAdapters'
]

const PACK_STEP: Record<PackMemberId, ConfigApplyStep> = {
  fileWatcher: 'packFileWatcher',
  connectionMonitor: 'packConnectionMonitor',
  processMonitor: 'packProcessMonitor',
  powershellTranscript: 'packPowershellTranscript'
}
const packMemberDeps = (member: PackMemberId): string[] => [`packs.${packOfMember(member)}`, `packMembers.${member}`]

/** The scope actually in force is the config's lists PLUS the scope file's
 *  entries, and the file can change on disk without the config changing. It is
 *  passed in beside the config so the planner stays pure; this is its path. */
export const SCOPE_IN_FORCE = '@scopeInForce'

/** Field → subsystem. Each entry is the config paths the subsystem's apply
 *  reads; a change at, above or below one of them plans the step. `*` means
 *  "any change at all" (cheap cache refreshes that read the whole config). */
export const CONFIG_DEPENDENCIES: Readonly<Record<ConfigApplyStep, readonly string[]>> = {
  ingestActiveTarget: ['engagement.activeTarget'],
  // Writes the `config_changed` audit row when a security-relevant field moved
  // (diffSecurityConfig decides which). Planned on every changing save; it is
  // a no-op when nothing it audits changed.
  audit: ['*'],
  wifiName: ['network.showWifiName'],
  // IP policy (white/blacklist), the IP producer (interval, providers,
  // confirmations, mode, air-gap — re-arming its timer fires a lookup), scope
  // policy (lists, file, alert floor) and the chain emitter's identity.
  alertRuntime: [
    'network.whitelist', 'network.blacklist', 'network.checkInterval', 'network.providers',
    'network.confirmations', 'network.ipMode', 'network.offline',
    'scope.targets', 'scope.excludeTargets', 'scope.warnOnViolation', 'scope.scopeFile',
    'operator', SCOPE_IN_FORCE
  ],
  screenshot: ['screenshot'],
  // Snapshot capture-health reads every on/off switch from; invalidates a
  // cache, starts and stops nothing.
  captureHealth: ['*'],
  // Restarts the proxy only when the endpoint moved and it is running.
  managedProxy: ['httpCapture.port', 'httpCapture.listenHost'],
  scopeRecompute: ['scope.targets', 'scope.excludeTargets', 'scope.warnOnViolation', 'scope.scopeFile'],
  terminal: ['terminal'],
  lootDetector: ['loot'],
  fileWatcherOptions: ['fileWatcher'],
  connectionMonitorOptions: ['connectionMonitor'],
  processMonitorOptions: ['processMonitor'],
  packFileWatcher: packMemberDeps('fileWatcher'),
  packConnectionMonitor: packMemberDeps('connectionMonitor'),
  packProcessMonitor: packMemberDeps('processMonitor'),
  packPowershellTranscript: packMemberDeps('powershellTranscript'),
  // Sources (authorization, roots, exclusions, session starts) and emitThinking
  // all go into one configureAgentTailer call that reloads the integrations.
  agentTailer: ['agentTailer'],
  redaction: ['redaction'],
  vpnAdapters: ['network.vpnAdapters'],
  powershellTranscriptIdentity: [],
  agentTailerHost: []
}

/** Paths a running project does not re-read when they change, and why. A
 *  change to one of these plans nothing — and is not an unknown path. */
export const NO_LIVE_EFFECT: Readonly<Record<string, string>> = {
  'engagement.id': 'immutable: the save keeps the stored id',
  'scope.personalDomains': 'read when exporting and querying, from the file',
  browser: 'read when the capture browser launches, from the file',
  'httpCapture.routeTerminals': 'read when a terminal spawns, from the file',
  retention: 'swept at project open; the periodic sweep keeps the open-time settings',
  overlay: 'legacy block, read once at open to seed the machine-wide HUD prefs'
}

/** What a plan is computed from: the config, and the scope in force beside it. */
export interface ConfigApplyInput {
  config: RedLogConfig
  /** `snapshotScope(config).targets` — includes the scope file's entries. */
  scopeInForce: readonly string[]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Leaf paths whose value differs. Arrays compare whole, by value. A section
 *  present on one side only is walked as if empty on the other, so adding
 *  `packMembers.fileWatcher` reads as that field, not as all of `packMembers`. */
export function changedConfigPaths(prev: unknown, next: unknown, at: string[] = []): string[][] {
  const walkable = (v: unknown): boolean => isPlainObject(v) || v === undefined
  if ((isPlainObject(prev) || isPlainObject(next)) && walkable(prev) && walkable(next)) {
    const a = (prev ?? {}) as Record<string, unknown>
    const b = (next ?? {}) as Record<string, unknown>
    const out: string[][] = []
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(...changedConfigPaths(a[key], b[key], [...at, key]))
    }
    return out
  }
  return JSON.stringify(prev) === JSON.stringify(next) ? [] : [at]
}

const overlaps = (dep: string, changed: string): boolean =>
  dep === '*' || dep === changed || changed.startsWith(`${dep}.`) || dep.startsWith(`${changed}.`)

const classified = (changed: string): boolean =>
  Object.values(CONFIG_DEPENDENCIES).some((deps) => deps.some((d) => d !== '*' && overlaps(d, changed))) ||
  Object.keys(NO_LIVE_EFFECT).some((p) => overlaps(p, changed))

export interface ConfigApplyPlan {
  /** In execution order. For `open` it includes the hooks. */
  entries: readonly ConfigApplyEntry[]
  /** Changed paths no entry in the map claims. Non-empty means "all steps". */
  unknownPaths: string[]
}

const PACK_STEPS: readonly ConfigApplyStep[] = [
  ...(Object.values(CAPTURE_PACKS).flatMap((p) => p.members) as PackMemberId[]).map((m) => PACK_STEP[m])
]
const inApplyOrder = (steps: Set<ConfigApplyStep>): ConfigApplyEntry[] =>
  APPLY_ORDER.filter((s) => steps.has(s)).map((step) => ({ step }))

/** The decision. `prev` is the config last applied to this project, or null
 *  when nothing has been. */
export function planConfigApply(prev: ConfigApplyInput | null, next: ConfigApplyInput, reason: ConfigApplyReason): ConfigApplyPlan {
  if (reason === 'open') return { entries: OPEN_SEQUENCE, unknownPaths: [] }
  // A new project's seed is applied by the open that follows it.
  if (reason === 'create') return { entries: [], unknownPaths: [] }

  const steps = new Set<ConfigApplyStep>()
  // Plugins decide whether a pack member or an AI source may run at all, and
  // the hook exclusions gate what the AI tailer reads: both are inputs the
  // config diff cannot see.
  if (reason === 'plugins-changed') { for (const s of PACK_STEPS) steps.add(s); steps.add('agentTailer') }
  if (reason === 'hook-config') steps.add('agentTailer')

  // Nothing applied yet for a project that is open is not expected; if it
  // happens, applying everything is the answer that cannot leave a source
  // configured for something else.
  if (!prev) {
    for (const s of APPLY_ORDER) if (s !== 'audit' || reason === 'save') steps.add(s)
    return { entries: inApplyOrder(steps), unknownPaths: [] }
  }

  const changed = changedConfigPaths(prev.config, next.config).map((p) => p.join('.'))
  if (JSON.stringify(prev.scopeInForce) !== JSON.stringify(next.scopeInForce)) changed.push(SCOPE_IN_FORCE)
  const unknownPaths = changed.filter((c) => c !== SCOPE_IN_FORCE && !classified(c))
  if (unknownPaths.length > 0) {
    for (const s of APPLY_ORDER) if (s !== 'audit' || reason === 'save') steps.add(s)
    return { entries: inApplyOrder(steps), unknownPaths }
  }
  for (const step of APPLY_ORDER) {
    if (step === 'audit' && reason !== 'save') continue
    if (CONFIG_DEPENDENCIES[step].some((dep) => changed.some((c) => overlaps(dep, c)))) steps.add(step)
  }
  return { entries: inApplyOrder(steps), unknownPaths: [] }
}
