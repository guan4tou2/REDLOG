// Registry for plugin-contributed command taggers. When a shell command_start
// event flows through the api-server, each registered pattern is tested; every
// match contributes its `stamp` fields onto the event's data. First-match-wins
// per field (later patterns don't overwrite an already-set field), so a more
// specific plugin can shadow a general one by loading first.
//
// Why this lives in core but has no built-in patterns: pattern lists (MITRE
// techniques, tool detection) are opinionated and stale fast — they belong in
// plugins (or the backend SIEM). Core just provides the registry.
//
// This runs on every shell command, in the main process. A pattern from a user
// plugin runs under the time bound loot rules have (bounded-regex.ts, #499): one
// that overruns is stopped and the rest carry on. A bundled plugin ships with
// the app and is run directly.

import { runBoundedRules } from './bounded-regex'

interface CompiledTag {
  pluginId: string
  name: string
  re: RegExp
  stamp: Record<string, string>
  source: 'bundled' | 'user'
  /** Set when the pattern overran the time bound and was stopped. Cleared by
   *  reloading the plugin, which registers the pattern afresh. */
  stopped?: 'time_limit'
}

const registry = new Map<string, CompiledTag[]>()
/** The user-plugin patterns of `registry`, so that a command with none of them
 *  does not pay for a trip to the worker. */
let userTags: CompiledTag[] = []

function refreshUserTags(): void {
  userTags = [...registry.values()].flat().filter((t) => t.source === 'user')
}

export interface CommandTagPattern {
  name: string
  match: string
  flags?: string
  stamp: Record<string, string>
}

export function registerCommandTags(
  pluginId: string,
  patterns: CommandTagPattern[],
  source: 'bundled' | 'user' = 'user'
): { accepted: number; rejected: Array<{ name: string; reason: string }> } {
  const compiled: CompiledTag[] = []
  const rejected: Array<{ name: string; reason: string }> = []
  for (const p of patterns) {
    try {
      compiled.push({ pluginId, name: p.name, re: new RegExp(p.match, p.flags), stamp: p.stamp, source })
    } catch (err) {
      // Invalid regex — skip it, and name it. The loader used to say only
      // that it "flags it separately", which it did not (#348).
      rejected.push({ name: p.name, reason: (err as Error).message })
    }
  }
  registry.set(pluginId, compiled)
  refreshUserTags()
  return { accepted: compiled.length, rejected }
}

export function unregisterCommandTags(pluginId: string): void {
  registry.delete(pluginId)
  refreshUserTags()
}

/** Apply all registered patterns against a command; return the merged stamp.
 *  Empty object when nothing matched — caller can spread it into event.data
 *  without a null check. */
export function tagCommand(command: string): Record<string, string> {
  const merged: Record<string, string> = {}
  // One trip to the worker for every user-plugin pattern; the stamps are then
  // applied in registration order, whichever way a pattern was run.
  const matchedInWorker = new Set<CompiledTag>()
  if (userTags.length > 0) {
    const results = runBoundedRules(
      userTags,
      (t) => ({ source: t.re.source, flags: t.re.flags, group: 0, once: true }),
      command,
      (t) => console.warn(`[command-tags] pattern ${t.pluginId}:${t.name} exceeded its time limit and was stopped`)
    )
    for (const [t, found] of results) if (found.length > 0) matchedInWorker.add(t)
  }
  for (const compiled of registry.values()) {
    for (const t of compiled) {
      if (t.source === 'user' ? !matchedInWorker.has(t) : !testStateless(t.re, command)) continue
      for (const [k, v] of Object.entries(t.stamp)) {
        if (merged[k] === undefined) merged[k] = v
      }
    }
  }
  return merged
}

/** `test` without the position a g or y flag keeps between calls. */
function testStateless(re: RegExp, command: string): boolean {
  re.lastIndex = 0
  return re.test(command)
}

/** For diagnostics — list every registered pattern across all plugins. */
export function _listCommandTags(): Array<{ pluginId: string; name: string; match: string; stamp: Record<string, string>; stopped?: 'time_limit' }> {
  const out: Array<{ pluginId: string; name: string; match: string; stamp: Record<string, string>; stopped?: 'time_limit' }> = []
  for (const compiled of registry.values()) {
    for (const t of compiled) out.push({ pluginId: t.pluginId, name: t.name, match: t.re.source, stamp: t.stamp, ...(t.stopped ? { stopped: t.stopped } : {}) })
  }
  return out
}
