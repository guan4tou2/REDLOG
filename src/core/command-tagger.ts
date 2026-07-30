// Registry for plugin-contributed command taggers. When a shell command_start
// event flows through the api-server, each registered pattern is tested; every
// match contributes its `stamp` fields onto the event's data. First-match-wins
// per field (later patterns don't overwrite an already-set field), so a more
// specific plugin can shadow a general one by loading first.
//
// Why this lives in core but has no built-in patterns: pattern lists (MITRE
// techniques, tool detection) are opinionated and stale fast — they belong in
// plugins (or the backend SIEM). Core just provides the registry.

interface CompiledTag {
  pluginId: string
  name: string
  re: RegExp
  stamp: Record<string, string>
}

const registry = new Map<string, CompiledTag[]>()

export interface CommandTagPattern {
  name: string
  match: string
  flags?: string
  stamp: Record<string, string>
}

export function registerCommandTags(pluginId: string, patterns: CommandTagPattern[]): void {
  const compiled: CompiledTag[] = []
  for (const p of patterns) {
    try {
      compiled.push({ pluginId, name: p.name, re: new RegExp(p.match, p.flags), stamp: p.stamp })
    } catch {
      // Invalid regex — skip; the plugin loader flags it separately.
    }
  }
  registry.set(pluginId, compiled)
}

export function unregisterCommandTags(pluginId: string): void {
  registry.delete(pluginId)
}

/** Apply all registered patterns against a command; return the merged stamp.
 *  Empty object when nothing matched — caller can spread it into event.data
 *  without a null check. */
export function tagCommand(command: string): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const compiled of registry.values()) {
    for (const t of compiled) {
      // Reset lastIndex for global regexes so the test is stateless.
      t.re.lastIndex = 0
      if (!t.re.test(command)) continue
      for (const [k, v] of Object.entries(t.stamp)) {
        if (merged[k] === undefined) merged[k] = v
      }
    }
  }
  return merged
}

/** For diagnostics — list every registered pattern across all plugins. */
export function listCommandTags(): Array<{ pluginId: string; name: string; match: string; stamp: Record<string, string> }> {
  const out: Array<{ pluginId: string; name: string; match: string; stamp: Record<string, string> }> = []
  for (const compiled of registry.values()) {
    for (const t of compiled) out.push({ pluginId: t.pluginId, name: t.name, match: t.re.source, stamp: t.stamp })
  }
  return out
}
