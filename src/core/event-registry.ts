// Declarative event-type registry (🟢). Plugins can teach RedLog about a new
// agent_type so the timeline gives it a label, lane, colour and icon instead of
// falling back to a generic "other" bucket. This is pure metadata — it changes
// how events RENDER, never how they're recorded or chained.

export interface EventTypeDef {
  agentType: string
  label: string
  lane?: string
  color?: string
  icon?: string
  pluginId: string
}

const registry = new Map<string, EventTypeDef>()

export function registerEventTypes(
  pluginId: string,
  defs: Array<{ agentType: string; label: string; lane?: string; color?: string; icon?: string }>
): void {
  for (const d of defs) {
    if (!d.agentType || !d.label) continue
    registry.set(`${pluginId}:${d.agentType}`, { ...d, pluginId })
  }
}

export function unregisterEventTypes(pluginId: string): void {
  for (const key of [...registry.keys()]) {
    if (registry.get(key)?.pluginId === pluginId) registry.delete(key)
  }
}

export function getEventTypes(): EventTypeDef[] {
  return [...registry.values()]
}
