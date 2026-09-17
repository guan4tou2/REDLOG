import type { LoadedPlugin, Capability } from './types'

// Runs 🔴 privileged plugin code in an isolated Electron utilityProcess. The
// child (resources/plugin-runner.js) can only reach RedLog through the
// capability-scoped RPC served here — it never sees the DB handle, the signing
// keys, or the main process. Every ctx call is checked against the operator's
// granted capabilities before the host executes it.
//
// v0.12: mcpTools removed (issue #88) — it was the only code contribution that
// used the utilityProcess host. The host still exists for exporters/monitors
// once those contribution types gain a dispatch path; the fork/RPC plumbing
// can be restored from git history (commit before this one).

// Services the host exposes to plugins, gated by capability. Provided by main so
// this module stays free of DB/API wiring.
export interface PluginServices {
  queryEvents: (args: Record<string, unknown>) => unknown
  searchEvents: (args: Record<string, unknown>) => unknown
  appendEvent: (pluginId: string, args: Record<string, unknown>) => unknown
  listFindings: (args: Record<string, unknown>) => unknown
  getConfig: () => unknown
  fetch: (args: Record<string, unknown>) => Promise<unknown>
}

// --- capability enforcement (used when serving a plugin's ctx RPC) ---

const CAP_FOR_METHOD: Record<string, Capability> = {
  'events.query': 'read:events',
  'events.search': 'read:events',
  'events.append': 'write:events',
  'findings.list': 'read:findings',
  'bookmarks.list': 'read:bookmarks',
  'config.get': 'read:config',
  'net.fetch': 'net:outbound'
}

export function methodAllowed(method: string, granted: Capability[]): boolean {
  const need = CAP_FOR_METHOD[method]
  if (!need) return false // unknown method → deny by default
  return granted.includes(need)
}

export function createPluginHost(_services: PluginServices): {
  start: (p: LoadedPlugin) => void
  stop: (pluginId: string) => void
} {
  return {
    start: (_p: LoadedPlugin): void => {
      // No code contributions are dispatched in this version. Exporters/monitors
      // will gain a dispatch path in a future release.
    },
    stop: (_pluginId: string): void => {}
  }
}
