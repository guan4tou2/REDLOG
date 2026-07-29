import type { Capability } from './types'

// Registry of MCP tools contributed by trusted 🔴 plugins. The MCP layer merges
// these into tools/list and routes tools/call for any name it owns to the
// plugin's dispatcher (which RPCs into that plugin's isolated process).
//
// Kept pure and Electron-free so it can be unit-tested; the host populates it.

export interface PluginTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  pluginId: string
}

export type PluginToolDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>

interface Entry {
  tools: PluginTool[]
  dispatch: PluginToolDispatch
}

const byPlugin = new Map<string, Entry>()

// Plugin tool names are namespaced to their plugin id so two plugins can't
// shadow each other or a built-in redlog_* tool.
export function toolName(pluginId: string, name: string): string {
  const clean = name.replace(/[^a-z0-9_]/gi, '_')
  return clean.startsWith(`${pluginId}_`) ? clean : `${pluginId.replace(/-/g, '_')}_${clean}`
}

export function registerPluginTools(pluginId: string, tools: Omit<PluginTool, 'pluginId'>[], dispatch: PluginToolDispatch): void {
  byPlugin.set(pluginId, {
    tools: tools.map((tdef) => ({ ...tdef, name: toolName(pluginId, tdef.name), pluginId })),
    dispatch
  })
}

export function unregisterPluginTools(pluginId: string): void {
  byPlugin.delete(pluginId)
}

export function listPluginTools(): PluginTool[] {
  return [...byPlugin.values()].flatMap((e) => e.tools)
}

/** Route a tools/call to the owning plugin. Returns undefined if no plugin owns it. */
export async function dispatchPluginTool(name: string, args: Record<string, unknown>): Promise<{ owned: boolean; result?: unknown }> {
  for (const entry of byPlugin.values()) {
    const tool = entry.tools.find((t) => t.name === name)
    if (tool) return { owned: true, result: await entry.dispatch(name, args) }
  }
  return { owned: false }
}

// --- capability enforcement (used by the host when serving a plugin's ctx RPC) ---

/** Map each ctx method the runner can call to the capability it requires. */
export const CAP_FOR_METHOD: Record<string, Capability> = {
  'events.query': 'read:events',
  'events.search': 'read:events',
  'events.append': 'write:events',
  'findings.list': 'read:findings',
  'config.get': 'read:config',
  'net.fetch': 'net:outbound'
}

export function methodAllowed(method: string, granted: Capability[]): boolean {
  const need = CAP_FOR_METHOD[method]
  if (!need) return false // unknown method → deny by default
  return granted.includes(need)
}
