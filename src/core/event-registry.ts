import type { Authority } from './authority'

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
  /** §3: does this type record an observation or a judgement? Optional like
   *  every other display field; unset means `fact` (see `authority.ts` for why
   *  that is the right default). A plugin whose type emits BOTH — some events
   *  observed, some inferred — leaves this unset and stamps `data.authority`
   *  per event instead, which always wins. */
  authority?: Authority
  pluginId: string
}

const registry = new Map<string, EventTypeDef>()

export function registerEventTypes(
  pluginId: string,
  defs: Array<{ agentType: string; label: string; lane?: string; color?: string; icon?: string; authority?: Authority }>
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

/** The `registered` lookup `authorityOf()` takes — resolves an agent_type to
 *  whatever authority a plugin declared for it, ignoring the pluginId prefix
 *  the registry keys by. */
export function registeredAuthority(agentType: string): Authority | undefined {
  for (const def of registry.values()) {
    if (def.agentType === agentType && def.authority) return def.authority
  }
  return undefined
}
