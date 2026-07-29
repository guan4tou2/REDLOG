import { join } from 'path'
import { registerLootPatterns, unregisterLootPatterns } from '../loot-detector'
import { registerRedactionRules, unregisterRedactionRules } from '../redaction'
import { registerTargetExtractors, unregisterTargetExtractors } from '../target-extractor'
import { registerEventTypes, unregisterEventTypes } from '../event-registry'
import { registerCapturePlugins, unregisterCapturePlugins } from '../hooks-manager'
import type { LoadedPlugin } from './types'

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

export function applyContributions(p: LoadedPlugin): void {
  const c = p.manifest.contributes ?? {}
  const id = p.manifest.id

  if (c.lootPatterns?.length) registerLootPatterns(id, c.lootPatterns)
  if (c.redaction) registerRedactionRules(id, c.redaction)
  if (c.targetExtractors?.length) registerTargetExtractors(id, c.targetExtractors)
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
}

export function removeContributions(pluginId: string): void {
  unregisterLootPatterns(pluginId)
  unregisterRedactionRules(pluginId)
  unregisterTargetExtractors(pluginId)
  unregisterEventTypes(pluginId)
  unregisterCapturePlugins(pluginId)
}
