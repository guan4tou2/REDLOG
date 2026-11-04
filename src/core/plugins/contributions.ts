import { join } from 'path'
import { registerLootPatterns, unregisterLootPatterns } from '../loot-detector'
import { registerRedactionRules, unregisterRedactionRules } from '../redaction'
import { registerCommandTags, unregisterCommandTags } from '../command-tagger'
import { registerTargetExtractors, unregisterTargetExtractors } from '../target-extractor'
import { registerEventTypes, unregisterEventTypes } from '../event-registry'
import { registerCapturePlugins, unregisterCapturePlugins } from '../hooks-manager'
import { registerTerminalProfiles, unregisterTerminalProfiles } from '../terminal-profiles'
import { contributeTailer, withdrawTailer, type TailerLike } from './tailer-registry'
import { installsHook } from './manifest'
import type { LoadedPlugin } from './types'
import type { RuleRejection } from '../loot-detector'
import type { RedactionRuleRejection } from '../redaction'

/** What actually took effect from one plugin. A manifest that loads is not the
 *  same as every rule in it working; this is where the difference is kept. */
export interface ContributionReport {
  lootPatterns?: { accepted: number; rejected: RuleRejection[] }
  redaction?: { accepted: number; rejected: RedactionRuleRejection[] }
  tailers?: { state: 'accepted' | 'rejected'; reason?: string }
  /** #348: the kinds that used to register and say nothing. A manifest that
   *  loads is not every rule in it working, and these are the four that could
   *  fail quietly — a bad regex, an unknown strategy, a capture with no hook
   *  file. Each rejected entry is named so the operator can find it. */
  targetExtractors?: { accepted: number; rejected: RuleRejection[] }
  commandTags?: { accepted: number; rejected: RuleRejection[] }
  eventTypes?: { accepted: number; rejected: RuleRejection[] }
  capture?: { accepted: number; rejected: RuleRejection[]; waiting?: boolean }
  /** #499: tool profiles for the terminal adapter. Accepted ones reach the
   *  shell only when `syncTerminalProfiles` writes the snapshot, which
   *  `initPlugins` does after every plugin has applied. */
  terminalProfiles?: { accepted: number; rejected: RuleRejection[]; waiting?: boolean }
}

/** Statuses in which a plugin has not been approved at its current hash. */
const AWAITING_APPROVAL: readonly string[] = ['needs-consent', 'hash-changed']

const reports = new Map<string, ContributionReport>()

export function getContributionReport(pluginId: string): ContributionReport | undefined {
  return reports.get(pluginId)
}

/** Why a plugin's tailer cannot run for its source, or null when it can. */
export function tailerUnsupportedReason(p: Pick<LoadedPlugin, 'source' | 'manifest'>): string | null {
  if (!p.manifest.contributes?.tailers) return null
  return p.source === 'bundled'
    ? null
    : 'Third-party tailers are not supported: RedLog does not run plugin code for transcript tailing. ' +
      'Send events through the local ingest API instead.'
}

// Applies a loaded plugin's 🟢 DECLARATIVE contributions into the running app.
// These never execute plugin code — they hand regexes, rule lists and metadata
// to the relevant subsystem. Privileged (🔴 code) contributions are handled
// separately by the host, and only after the trust gate passes.

/** Replace {hookFile} in manual-step text with the capture's absolute path. */
function fillHookPath(steps: Array<{ label: string; command?: string }> | undefined, absHook: string) {
  if (!steps) return undefined
  return steps.map((s) => ({
    label: s.label.replaceAll('{hookFile}', absHook),
    command: s.command?.replaceAll('{hookFile}', absHook)
  }))
}

export function applyContributions(p: LoadedPlugin): ContributionReport {
  const c = p.manifest.contributes ?? {}
  const id = p.manifest.id
  const report: ContributionReport = {}
  if (c.lootPatterns?.length) {
    const r = registerLootPatterns(id, c.lootPatterns)
    report.lootPatterns = { accepted: r.added, rejected: r.rejected }
  }
  if (c.redaction) {
    const r = registerRedactionRules(id, c.redaction)
    report.redaction = { accepted: r.accepted, rejected: r.rejected }
  }
  if (c.commandTags?.length) {
    const r = registerCommandTags(id, c.commandTags, p.source)
    report.commandTags = r
  }
  if (c.targetExtractors?.length) {
    const r = registerTargetExtractors(id, c.targetExtractors, p.source)
    report.targetExtractors = r
  }
  if (c.eventTypes?.length) {
    const r = registerEventTypes(id, c.eventTypes)
    report.eventTypes = r
  }
  if (c.terminalProfiles?.length) {
    // A profile changes what the shell does to what the operator types, so it
    // waits for the operator's approval of this exact content. `loader` gives a
    // plugin that declares profiles `needs-consent` until it is approved (see
    // `requiresApproval`), code or no code, and again when the manifest changes.
    if (AWAITING_APPROVAL.includes(p.status)) {
      report.terminalProfiles = { accepted: 0, rejected: [], waiting: true }
    } else {
      const r = registerTerminalProfiles(id, c.terminalProfiles)
      report.terminalProfiles = { accepted: r.accepted, rejected: r.rejected }
    }
  }
  if (c.capture?.length) {
    // A capture RedLog installs becomes a script in the operator's shell or in
    // Claude Code's settings, so it waits for approval of this exact content
    // like terminal profiles do (see `requiresApproval`); a manual one only
    // shows steps and registers at once.
    const waiting = AWAITING_APPROVAL.includes(p.status)
    const entries = waiting ? c.capture.filter((cap) => !installsHook(cap)) : c.capture
    const r = registerCapturePlugins(
      id,
      p.dir,
      entries.map((cap) => ({
        id: cap.id,
        name: cap.name,
        description: cap.description,
        agentType: cap.agentType,
        emits: cap.emits,
        platforms: cap.platforms,
        requires: cap.requires,
        hookFile: cap.hookFile,
        installMethod: cap.installMethod,
        installTarget: cap.installTarget,
        shellRcFile: cap.shellRcFile,
        claudeSettingsMatcher: cap.claudeSettingsMatcher,
        manualSteps: fillHookPath(cap.manualSteps, join(p.dir, cap.hookFile))
      }))
    )
    report.capture = waiting && entries.length < c.capture.length ? { ...r, waiting: true } : r
  }

  // v0.8.2: `tailers` contribution. Bundled plugins only — user-plugin
  // tailer isolation is deferred to v0.8.3+. Silently skip user plugins
  // with an advisory to console; a real emission via insertEvent would
  // require pulling core → main-services dependency, which we avoid here.
  if (c.tailers) {
    // v0.11.0: `tailers` is in PRIVILEGED_KEYS — it makes RedLog `require()`
    // plugin-supplied code — but it was reached through applyContributions,
    // which runs for anything not `error`/`disabled`. The trust gate only
    // guarded `host.start()`, so a plugin sitting at `needs-consent` or
    // `hash-changed` had its tailer module executed in the MAIN process before
    // the operator had agreed to anything, and with no capability limits.
    //
    // Latent until now only because of the bundled-only rule below. Both gates
    // stay: bundled-only because third-party tailer isolation is still
    // unbuilt (parseUnit runs per transcript line and does sync fs I/O, which
    // the per-call utilityProcess model cannot absorb), and the trust check
    // because "we shipped it" is not the same as "the operator consented to
    // this exact content" — the pinned hash is what makes an update visible.
    const unsupported = tailerUnsupportedReason(p)
    if (unsupported) {
      // Stated whatever the trust status: consent must not make an
      // unsupported source look usable.
      report.tailers = { state: 'rejected', reason: unsupported }
      console.warn(`[plugins] tailer contribution from user plugin "${id}" rejected — ${unsupported}`)
    } else if (p.status !== 'active') {
      report.tailers = { state: 'rejected', reason: `plugin status is "${p.status}"; privileged code does not run before consent` }
      console.warn(
        `[plugins] tailer contribution from "${id}" skipped — plugin status is ` +
        `"${p.status}", not "active". Privileged code does not run before consent.`
      )
    } else {
      try {
        // Runtime require against the plugin dir. Manifest validation
        // already guarantees the module path stays inside the plugin
        // directory + exists on disk.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(join(p.dir, c.tailers)) as { adapter?: TailerLike }
        const adapter = mod?.adapter
        if (!adapter || typeof adapter.agentKind !== 'string' || !adapter.agentKind) {
          report.tailers = { state: 'rejected', reason: 'module has no valid "adapter.agentKind" export' }
          console.error(
            `[plugins] tailer module for "${id}" is missing a valid ` +
            `"adapter.agentKind" export; skipping.`
          )
        } else {
          contributeTailer(id, adapter)
          report.tailers = { state: 'accepted' }
        }
      } catch (e) {
        report.tailers = { state: 'rejected', reason: `tailer failed to load: ${(e as Error).message}` }
        console.error(`[plugins] tailer load failed for "${id}":`, e)
      }
    }
  }
  // A plugin that contributed nothing leaves no report behind: "no report" is
  // the operator-facing state for "this plugin registered nothing", read as
  // "no diagnosis yet" rather than "all accepted" (Spec 065). Storing the
  // empty object here would make every contribution-less plugin look diagnosed.
  if (Object.keys(report).length > 0) reports.set(id, report)
  return report
}

export function removeContributions(pluginId: string): void {
  reports.delete(pluginId)
  // First, and on its own: the profiles are what the shell acts on, so one
  // kind failing to come back must not leave them registered.
  unregisterTerminalProfiles(pluginId)
  unregisterLootPatterns(pluginId)
  unregisterRedactionRules(pluginId)
  unregisterCommandTags(pluginId)
  unregisterTargetExtractors(pluginId)
  unregisterEventTypes(pluginId)
  unregisterCapturePlugins(pluginId)
  withdrawTailer(pluginId)
}
