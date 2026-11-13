// Runs what src/core/config-apply-plan.ts decides. Every way a config becomes
// current goes through `apply`: project open, a save, a plugin change, the
// hook exclusions, the current-target switch, a new project's seed.
//
// What each step passes to its subsystem is written here once, so open and save
// cannot drift apart again — they used to be two hand-copied lists in
// main/index.ts. The subsystems themselves arrive as `deps`, so the sequence
// can be run against stand-ins (test/config-apply.test.ts).
//
// Applies do not interleave. The work is synchronous on main's thread, so two
// IPC saves cannot overlap; what can happen is a step that causes another
// apply (a plugin load announcing a change), or an apply requested for a
// project that has since closed. The first is queued and coalesced — the last
// config requested is the one applied, with every reason's steps — and the
// second is dropped: a project's config is never applied to the next one.

import { alertFloorFor } from '../core/alert'
import type { ScopeSnapshot } from '../core/alert/policies'
import { agentTranscriptRoot, resolveAgentCapture } from '../core/agent-capture-policy'
import { isPackMemberOn, type PackMemberId } from '../core/capture-packs'
import { snapshotScope, type RedLogConfig } from '../core/config'
import {
  APPLY_ORDER, planConfigApply,
  type ConfigApplyEntry, type ConfigApplyHook, type ConfigApplyInput, type ConfigApplyPlan, type ConfigApplyReason, type ConfigApplyStep
} from '../core/config-apply-plan'
import type { LoadedPlugin } from '../core/plugins/types'
import type { OfficialAgentPlugin } from '../core/plugins/official-agents'
import type { ProjectContext } from '../core/project-runtime'
import type { VpnAdapter } from '../core/config'

type Opts = Record<string, unknown>

/** The subsystems, as main/index.ts binds them. Names follow the call they
 *  stand for, so the golden list in the test reads like the old code. */
export interface ConfigApplyDeps {
  isCurrent(identity: ProjectContext): boolean
  getShowWifiName(): boolean
  setShowWifiName(on: boolean): void
  publishLink(): void
  broadcastIPStatus(): void
  screenshotConfigure(opts: Opts): void
  alertResetOnProjectSwitch(): void
  alertConfigure(config: RedLogConfig, identity: ProjectContext, scopeTargets: string[]): void
  lootConfigure(opts: Opts): void
  configureCaptureHealth(config: Record<string, unknown>): void
  configureRedaction(redaction: RedLogConfig['redaction']): void
  setVpnAdapters(adapters: VpnAdapter[]): void
  configureTerminal(opts: { identity: ProjectContext; maxCastBytes?: number }): void
  /** Open only: the loot detector, alert runtime and cast probe ingest needs. */
  ingestCollaborators(): Opts
  configureIngest(opts: Opts): void
  configureFileWatcher(opts: Opts): unknown
  configureConnectionMonitor(opts: Opts): void
  configurePowershellTranscript(opts: Opts): unknown
  configureProcessMonitor(opts: Opts): void
  configureAgentTailer(opts: Opts): void
  logConfigDiff(prev: RedLogConfig, next: RedLogConfig): string | null
  proxyEndpoint(config: RedLogConfig): { host: string; port: number }
  proxyRunning(): boolean
  stopManagedHttpCapture(): void
  startManagedHttpCapture(): void
  scheduleScopeRecompute(before: ScopeSnapshot, configChangedId: string | null): void
  apiPort(): number
  lootDetector: unknown
  scopeDispatch: (input: never) => void
  hookExcludedPaths(): string[]
  listPlugins(): LoadedPlugin[]
  agentCatalog(): { catalog: OfficialAgentPlugin[]; modulePath(agentKind: string): string | undefined }
  homedir(): string
}

export interface ConfigApplyRequest {
  reason: ConfigApplyReason
  /** The project this config belongs to: its open's context. */
  identity: ProjectContext
  next: RedLogConfig
  /** What the file held before this write. The audit row and the scope
   *  recompute describe the change from it; it defaults to the last applied. */
  diskPrev?: RedLogConfig
  /** Open only: the open's own work between two steps. */
  hooks?: Partial<Record<ConfigApplyHook, () => void>>
}

export interface ConfigApplier {
  /** The plan that ran, or null when the request was dropped (stale project)
   *  or queued behind a running apply (it runs before this call returns). */
  apply(request: ConfigApplyRequest): ConfigApplyPlan | null
  /** Project closed: forget what was applied and anything queued. */
  reset(): void
  /** What was last applied, for the project it was applied to. */
  applied(): { generation: number; input: ConfigApplyInput } | null
}

const PACK_MEMBER: Partial<Record<ConfigApplyStep, PackMemberId>> = {
  packFileWatcher: 'fileWatcher',
  packConnectionMonitor: 'connectionMonitor',
  packProcessMonitor: 'processMonitor',
  packPowershellTranscript: 'powershellTranscript'
}

interface StepContext {
  reason: ConfigApplyReason
  identity: ProjectContext
  next: ConfigApplyInput
  diskPrev: RedLogConfig | null
  /** Shared by the steps of one run: the audit row's id for the recompute,
   *  and the plugin list, read once like applyCapturePacks read it. */
  configChangedId: string | null
  plugins: LoadedPlugin[] | null
}

function runStep(step: ConfigApplyStep, ctx: StepContext, deps: ConfigApplyDeps): void {
  const cfg = ctx.next.config
  const open = ctx.reason === 'open'
  const plugins = (): LoadedPlugin[] => (ctx.plugins ??= deps.listPlugins())
  switch (step) {
    case 'wifiName': {
      const on = cfg.network?.showWifiName === true
      if (open) { deps.setShowWifiName(on); return }
      // Turning the SSID off applies now, not at the next poll.
      if (deps.getShowWifiName() !== on) { deps.setShowWifiName(on); deps.publishLink(); deps.broadcastIPStatus() }
      return
    }
    case 'screenshot':
      deps.screenshotConfigure({
        ...(open ? { identity: ctx.identity } : {}),
        quality: cfg.screenshot.quality,
        intervalSec: cfg.screenshot.intervalSec ?? 0,
        diffThreshold: cfg.screenshot.diffThreshold ?? 5,
        captureOnCommand: cfg.screenshot.captureOnCommand ?? false
      })
      return
    case 'alertRuntime':
      // A switch drops correlation/burst history so the previous engagement's
      // verdict cannot fire on the new one's first tick.
      if (open) deps.alertResetOnProjectSwitch()
      deps.alertConfigure(cfg, ctx.identity, [...ctx.next.scopeInForce])
      return
    case 'lootDetector':
      deps.lootConfigure({ ...(open ? { identity: ctx.identity } : {}), disabledRules: cfg.loot?.disabledRules ?? [] })
      return
    case 'captureHealth':
      deps.configureCaptureHealth(cfg as unknown as Record<string, unknown>)
      return
    case 'redaction':
      if (open || cfg.redaction) deps.configureRedaction(cfg.redaction)
      return
    case 'vpnAdapters':
      deps.setVpnAdapters(cfg.network.vpnAdapters)
      return
    case 'terminal':
      deps.configureTerminal({ identity: ctx.identity, maxCastBytes: cfg.terminal?.maxCastBytes })
      return
    case 'ingestActiveTarget':
      deps.configureIngest({ ...(open ? deps.ingestCollaborators() : {}), activeTarget: cfg.engagement.activeTarget ?? null })
      return
    case 'audit':
      if (ctx.diskPrev) ctx.configChangedId = deps.logConfigDiff(ctx.diskPrev, cfg)
      return
    case 'managedProxy': {
      if (!ctx.diskPrev) return
      const before = deps.proxyEndpoint(ctx.diskPrev)
      const after = deps.proxyEndpoint(cfg)
      if ((before.port !== after.port || before.host !== after.host) && deps.proxyRunning()) {
        deps.stopManagedHttpCapture()
        deps.startManagedHttpCapture()
      }
      return
    }
    case 'scopeRecompute': {
      if (!ctx.diskPrev) return
      // Re-judge what is already recorded against the boundary that now
      // applies; scheduled, so the save does not wait on a scan.
      const before = snapshotScope(ctx.diskPrev)
      deps.scheduleScopeRecompute({
        targets: before.targets,
        excludeTargets: before.excludeTargets,
        alertFloor: alertFloorFor(ctx.diskPrev.scope?.warnOnViolation)
      }, ctx.configChangedId)
      return
    }
    case 'fileWatcherOptions':
      void deps.configureFileWatcher({
        watchPaths: cfg.fileWatcher?.watchPaths ?? [],
        ignorePatterns: cfg.fileWatcher?.ignorePatterns ?? [],
        ...(open ? { identity: ctx.identity } : {})
      })
      return
    case 'connectionMonitorOptions':
      deps.configureConnectionMonitor({
        pollMs: cfg.connectionMonitor?.pollMs,
        ...(open ? { identity: ctx.identity } : {}),
        selfPorts: [deps.apiPort()]
      })
      return
    case 'powershellTranscriptIdentity':
      void deps.configurePowershellTranscript({ identity: ctx.identity })
      return
    case 'processMonitorOptions':
      deps.configureProcessMonitor({
        pollMs: cfg.processMonitor?.pollMs,
        ignoreCommands: cfg.processMonitor?.ignoreCommands ?? [],
        ...(open ? { identity: ctx.identity } : {})
      })
      return
    case 'agentTailerHost':
      // AI capture is separately installed and authorized by this project;
      // agent tool calls reach the scope policy like a shell command does.
      deps.configureAgentTailer({
        identity: ctx.identity,
        excludedPaths: deps.hookExcludedPaths(),
        emitThinking: cfg.agentTailer?.emitThinking ?? false,
        scopeDispatch: deps.scopeDispatch
      })
      return
    case 'packFileWatcher':
    case 'packConnectionMonitor':
    case 'packProcessMonitor':
    case 'packPowershellTranscript': {
      // Per member, not per pack: the pack switch is the preset and
      // `packMembers` records where the operator departed from it. Nothing
      // here defaults a pack on.
      const member = PACK_MEMBER[step]!
      const enabled = isPackMemberOn(cfg, member, plugins())
      if (member === 'fileWatcher') void deps.configureFileWatcher({ enabled })
      else if (member === 'connectionMonitor') deps.configureConnectionMonitor({ enabled })
      else if (member === 'processMonitor') deps.configureProcessMonitor({ enabled })
      else void deps.configurePowershellTranscript({ enabled })
      return
    }
    case 'agentTailer': {
      // Agent transcripts can hold unrelated work from the operator's home
      // directory: only an installed, authorized, project-enabled source runs.
      const { catalog, modulePath } = deps.agentCatalog()
      const agents = resolveAgentCapture(cfg, catalog, plugins())
      deps.configureAgentTailer({
        integrations: agents.flatMap((a) => {
          const entry = catalog.find((p) => p.agentKind === a.agentKind)!
          const file = modulePath(a.agentKind)
          return file ? [{ agentKind: a.agentKind, modulePath: file, root: agentTranscriptRoot(entry, deps.homedir(), cfg.agentTailer?.sources?.[a.agentKind]) }] : []
        }),
        enabled: agents.length > 0, enabledAgents: agents.map((a) => a.agentKind),
        identity: ctx.identity, emitThinking: cfg.agentTailer?.emitThinking ?? false,
        watchPathsByAgent: Object.fromEntries(agents.map((a) => [a.agentKind, a.workPaths])),
        activationStarts: Object.fromEntries(agents.map((a) => [a.agentKind, a.startedAt])),
        excludedSessionsByAgent: Object.fromEntries(agents.map((a) => [a.agentKind, cfg.agentTailer?.sources?.[a.agentKind]?.excludedSessions ?? []])),
        sessionStartsByAgent: Object.fromEntries(agents.map((a) => [a.agentKind, cfg.agentTailer?.sources?.[a.agentKind]?.sessionStarts ?? {}])),
        excludedPaths: deps.hookExcludedPaths()
      })
      return
    }
  }
}

interface Pending {
  identity: ProjectContext
  reasons: Set<ConfigApplyReason>
  next: RedLogConfig
  diskPrev?: RedLogConfig
}

export function createConfigApplier(deps: ConfigApplyDeps): ConfigApplier {
  let applied: { generation: number; input: ConfigApplyInput } | null = null
  let running = false
  let pending: Pending | null = null

  const inputOf = (config: RedLogConfig): ConfigApplyInput => ({ config, scopeInForce: snapshotScope(config).targets })

  function execute(entries: readonly ConfigApplyEntry[], ctx: StepContext, hooks: ConfigApplyRequest['hooks']): void {
    for (const entry of entries) {
      // A project switch inside an apply ends it: nothing more of this
      // project's config reaches the sources the next one now owns.
      if (!deps.isCurrent(ctx.identity)) return
      if ('hook' in entry) hooks?.[entry.hook]?.()
      else runStep(entry.step, ctx, deps)
    }
  }

  function planFor(reasons: Iterable<ConfigApplyReason>, prev: ConfigApplyInput | null, next: ConfigApplyInput): ConfigApplyPlan {
    const steps = new Set<ConfigApplyStep>()
    const unknownPaths = new Set<string>()
    for (const reason of reasons) {
      const plan = planConfigApply(prev, next, reason)
      for (const e of plan.entries) if ('step' in e) steps.add(e.step)
      for (const p of plan.unknownPaths) unknownPaths.add(p)
    }
    return { entries: APPLY_ORDER.filter((s) => steps.has(s)).map((step) => ({ step })), unknownPaths: [...unknownPaths] }
  }

  function run(identity: ProjectContext, reasons: Set<ConfigApplyReason>, nextConfig: RedLogConfig, diskPrev: RedLogConfig | undefined,
    hooks: ConfigApplyRequest['hooks']): ConfigApplyPlan {
    const next = inputOf(nextConfig)
    const open = reasons.has('open')
    const prev = !open && applied?.generation === identity.generation ? applied.input : null
    const plan = open ? planConfigApply(null, next, 'open') : planFor(reasons, prev, next)
    const ctx: StepContext = {
      reason: open ? 'open' : (reasons.has('save') ? 'save' : [...reasons][0]),
      identity, next, diskPrev: diskPrev ?? prev?.config ?? null, configChangedId: null, plugins: null
    }
    running = true
    try {
      execute(plan.entries, ctx, hooks)
    } finally {
      running = false
    }
    // `create` writes a project that is not (yet) the applied one.
    if (!reasons.has('create') && deps.isCurrent(identity)) applied = { generation: identity.generation, input: next }
    return plan
  }

  function drain(): void {
    while (pending && !running) {
      const job = pending
      pending = null
      if (!deps.isCurrent(job.identity)) continue
      run(job.identity, job.reasons, job.next, job.diskPrev, undefined)
    }
  }

  return {
    apply(request) {
      if (request.reason === 'create') return { entries: [], unknownPaths: [] }
      if (!deps.isCurrent(request.identity)) return null
      if (request.reason === 'open') {
        // A new open owns everything from here: what was applied, and anything
        // queued, belonged to the open before it.
        applied = null
        pending = null
      }
      if (running) {
        // Coalesce: the newest config, every reason's steps, and the earliest
        // file state the audit and recompute describe the change from.
        if (pending && pending.identity === request.identity) {
          pending.reasons.add(request.reason)
          pending.next = request.next
          pending.diskPrev ??= request.diskPrev
        } else {
          pending = { identity: request.identity, reasons: new Set([request.reason]), next: request.next, diskPrev: request.diskPrev }
        }
        return null
      }
      const plan = run(request.identity, new Set([request.reason]), request.next, request.diskPrev, request.hooks)
      drain()
      return plan
    },
    reset() {
      applied = null
      pending = null
    },
    applied: () => applied
  }
}
