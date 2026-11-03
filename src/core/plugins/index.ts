import { loadPlugins } from './loader'
import { requiresApproval } from './manifest'
import { applyContributions, removeContributions, tailerUnsupportedReason } from './contributions'
import { grant, revoke } from './trust'
import { setDisabled } from './state'
import { getEventTypes } from '../event-registry'
import { checkTerminalProfiles, syncTerminalProfiles } from '../terminal-profiles'
import type { LoadedPlugin, Capability } from './types'

// Public plugin API used by the main process + IPC. Owns the in-memory set of
// loaded plugins and keeps subsystem contributions in sync with it.
//
// Declarative contributions (data RedLog reads) apply for every non-error,
// non-disabled plugin, except that what changes what the shell does to a
// command (`terminalProfiles`) and what runs code (`tailers`) wait for the
// operator's approval: the loader gives such a plugin 'needs-consent' until it
// is approved at its current content (see `requiresApproval`). Plugin code only
// runs when the plugin is 'active' and is started/stopped by the host module
// (see host.ts), which this module invokes if present.

let current: LoadedPlugin[] = []
let profilesError: string | undefined

/** One plugin's contributions, each in a turn of their own. A plugin that
 *  throws while it applies is an error plugin with the reason, not a reason for
 *  the plugins after it, or the write of the shell's snapshot, not to happen. */
function applyAll(plugins: LoadedPlugin[]): void {
  for (const p of plugins) {
    if (p.status === 'error' || p.status === 'disabled') continue
    try {
      // Contributions apply here; the one privileged kind, `tailers`, checks
      // trust itself inside applyContributions.
      applyContributions(p)
    } catch (e) {
      const message = (e as Error)?.message ?? String(e)
      try { removeContributions(p.manifest.id) } catch { /* what it had registered stays registered only if this too failed */ }
      p.status = 'error'
      p.error = `contributions could not be applied: ${message}`
      console.error(`[plugins] "${p.manifest.id}" failed while applying its contributions:`, e)
    }
  }
}

function removeAll(plugins: LoadedPlugin[]): void {
  for (const p of plugins) {
    // One plugin that cannot be taken back must not leave the rest applied.
    try { removeContributions(p.manifest.id) } catch (e) {
      console.error(`[plugins] could not take back the contributions of "${p.manifest.id}":`, e)
    }
  }
}

export interface PluginInitSummary {
  total: number
  active: number
  needsConsent: number
  errors: number
  /** Set when the shell's snapshot of tool profiles could not be brought up to
   *  date: the profiles it last had may still be in effect in new terminals,
   *  including ones that were just revoked or disabled. */
  profilesError?: string
}

export function initPlugins(): PluginInitSummary {
  try {
    removeAll(current)
    current = loadPlugins()
    applyAll(current)
  } finally {
    // Whatever went wrong above, the snapshot is rewritten from what is
    // approved and registered right now. A revoke that left the old file in
    // place because another plugin threw would be the revoke not happening.
    profilesError = writeTerminalProfiles()
  }
  return summarise(current)
}

// Every way a plugin appears, goes, is enabled or disabled ends here, so this
// is the one place the shell's snapshot of their tool profiles is rewritten.
// A failure is the snapshot staying as it was, and is returned: the plugins
// have loaded either way, but the operator is told the shell may disagree.
function writeTerminalProfiles(): string | undefined {
  try {
    const r = syncTerminalProfiles()
    if (r.error) console.warn(`[plugins] terminal profiles not written: ${r.error}`)
    return r.error
  } catch (e) {
    const message = (e as Error).message
    console.warn(`[plugins] terminal profiles not written: ${message}`)
    return message
  }
}

/** Why the shell's snapshot of tool profiles is not current, or undefined. */
export function terminalProfilesError(): string | undefined {
  return profilesError
}

/** Re-scan disk + re-apply. Call after install/enable/disable/trust changes. */
export function reloadPlugins(): PluginInitSummary {
  return initPlugins()
}

export function listPlugins(): LoadedPlugin[] {
  return current
}

export function listEventTypes(): ReturnType<typeof getEventTypes> {
  return getEventTypes()
}

export function setPluginEnabled(pluginId: string, enabled: boolean): PluginInitSummary {
  setDisabled(pluginId, !enabled)
  return reloadPlugins()
}

/**
 * Approve a plugin that needs it: one that runs code, or one that declares
 * terminal profiles. Pins the CURRENT content hash and the capabilities the
 * manifest requests, then reloads so the host starts it. `profilesError` says
 * the approval is recorded but the shell's snapshot could not be written.
 */
export function grantPluginTrust(pluginId: string, grantedBy?: string): { ok: boolean; error?: string; profilesError?: string } {
  const p = current.find((x) => x.manifest.id === pluginId)
  if (!p) return { ok: false, error: 'plugin not found' }
  if (!requiresApproval(p.manifest)) return { ok: false, error: 'plugin needs no approval' }
  if (p.status === 'error') return { ok: false, error: p.error ?? 'plugin failed to load' }
  // Consent cannot make an unsupported source work, and must not look as if it
  // did. A third-party tailer that also declares profiles is the exception: the
  // tailer still does not run, whatever is agreed, but the profiles are the
  // operator's to approve and would otherwise have no way to be.
  const unsupported = tailerUnsupportedReason(p)
  if (unsupported && checkTerminalProfiles(pluginId, p.manifest.contributes?.terminalProfiles).accepted.length === 0) {
    return { ok: false, error: unsupported }
  }
  grant(pluginId, p.contentHash, (p.manifest.capabilities ?? []) as Capability[], grantedBy)
  const { profilesError: stale } = reloadPlugins()
  return stale === undefined ? { ok: true } : { ok: true, profilesError: stale }
}

export function revokePluginTrust(pluginId: string): PluginInitSummary {
  revoke(pluginId)
  return reloadPlugins()
}

function summarise(plugins: LoadedPlugin[]): PluginInitSummary {
  return {
    total: plugins.length,
    active: plugins.filter((p) => p.status === 'active').length,
    needsConsent: plugins.filter((p) => p.status === 'needs-consent' || p.status === 'hash-changed').length,
    errors: plugins.filter((p) => p.status === 'error').length,
    ...(profilesError === undefined ? {} : { profilesError })
  }
}

export type { LoadedPlugin } from './types'
