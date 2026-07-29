import { loadPlugins } from './loader'
import { applyContributions, removeContributions } from './contributions'
import { grant, revoke } from './trust'
import { setDisabled } from './state'
import { getEventTypes } from '../event-registry'
import type { LoadedPlugin, Capability } from './types'

// Public plugin API used by the main process + IPC. Owns the in-memory set of
// loaded plugins and keeps subsystem contributions in sync with it.
//
// 🟢 declarative contributions apply for every non-error, non-disabled plugin
// (they're data, always safe). 🔴 privileged code only runs when the plugin is
// 'active' — i.e. the trust gate passed — and is started/stopped by the host
// module (see host.ts), which this module invokes if present.

let current: LoadedPlugin[] = []

// The host is wired in lazily to avoid a hard dependency (and so the pure
// declarative path stays testable without Electron's utilityProcess).
type Host = {
  start: (p: LoadedPlugin) => void
  stop: (pluginId: string) => void
}
let host: Host | null = null
export function setPluginHost(h: Host | null): void { host = h }

function applyAll(plugins: LoadedPlugin[]): void {
  for (const p of plugins) {
    if (p.status === 'error' || p.status === 'disabled') continue
    // declarative parts are always safe to apply
    applyContributions(p)
    // privileged code only runs once trusted
    if (p.tier === 'privileged' && p.status === 'active') host?.start(p)
  }
}

function removeAll(plugins: LoadedPlugin[]): void {
  for (const p of plugins) {
    removeContributions(p.manifest.id)
    if (p.tier === 'privileged') host?.stop(p.manifest.id)
  }
}

export interface PluginInitSummary {
  total: number
  active: number
  needsConsent: number
  errors: number
}

export function initPlugins(): PluginInitSummary {
  removeAll(current)
  current = loadPlugins()
  applyAll(current)
  return summarise(current)
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
 * Grant a privileged plugin trust to run its code. Pins the CURRENT content hash
 * and the capabilities the manifest requests, then reloads so the host starts it.
 */
export function grantPluginTrust(pluginId: string, grantedBy?: string): { ok: boolean; error?: string } {
  const p = current.find((x) => x.manifest.id === pluginId)
  if (!p) return { ok: false, error: 'plugin not found' }
  if (p.tier !== 'privileged') return { ok: false, error: 'plugin requests no privileged capabilities' }
  if (p.status === 'error') return { ok: false, error: p.error ?? 'plugin failed to load' }
  grant(pluginId, p.contentHash, (p.manifest.capabilities ?? []) as Capability[], grantedBy)
  reloadPlugins()
  return { ok: true }
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
    errors: plugins.filter((p) => p.status === 'error').length
  }
}

export type { LoadedPlugin } from './types'
