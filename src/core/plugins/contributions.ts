import { join } from 'path'
import { registerLootPatterns, unregisterLootPatterns } from '../loot-detector'
import { registerRedactionRules, unregisterRedactionRules } from '../redaction'
import { registerCommandTags, unregisterCommandTags } from '../command-tagger'
import { registerTargetExtractors, unregisterTargetExtractors } from '../target-extractor'
import { registerEventTypes, unregisterEventTypes } from '../event-registry'
import { registerCapturePlugins, unregisterCapturePlugins } from '../hooks-manager'
import { contributeTailer, withdrawTailer, type TailerLike } from './tailer-registry'
import type { LoadedPlugin } from './types'
import type { RuleRejection } from '../loot-detector'

/** What actually took effect from one plugin. A manifest that loads is not the
 *  same as every rule in it working; this is where the difference is kept. */
export interface ContributionReport {
  lootPatterns?: { accepted: number; rejected: RuleRejection[] }
  tailers?: { state: 'accepted' | 'rejected'; reason?: string }
}

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
  reports.set(id, report)
  if (c.lootPatterns?.length) {
    const r = registerLootPatterns(id, c.lootPatterns)
    report.lootPatterns = { accepted: r.added, rejected: r.rejected }
  }
  if (c.redaction) registerRedactionRules(id, c.redaction)
  if (c.commandTags?.length) registerCommandTags(id, c.commandTags)
  if (c.targetExtractors?.length) registerTargetExtractors(id, c.targetExtractors, p.source)
  if (c.eventTypes?.length) registerEventTypes(id, c.eventTypes)
  if (c.capture?.length) {
    registerCapturePlugins(
      id,
      p.dir,
      c.capture.map((cap) => ({
        id: cap.id,
        name: cap.name,
        description: cap.description,
        agentType: cap.agentType,
        emits: cap.emits,
        requires: cap.requires,
        hookFile: cap.hookFile,
        installMethod: cap.installMethod,
        installTarget: cap.installTarget,
        shellRcFile: cap.shellRcFile,
        claudeSettingsMatcher: cap.claudeSettingsMatcher,
        manualSteps: fillHookPath(cap.manualSteps, join(p.dir, cap.hookFile))
      }))
    )
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
  return report
}

export function removeContributions(pluginId: string): void {
  reports.delete(pluginId)
  unregisterLootPatterns(pluginId)
  unregisterRedactionRules(pluginId)
  unregisterCommandTags(pluginId)
  unregisterTargetExtractors(pluginId)
  unregisterEventTypes(pluginId)
  unregisterCapturePlugins(pluginId)
  withdrawTailer(pluginId)
}
