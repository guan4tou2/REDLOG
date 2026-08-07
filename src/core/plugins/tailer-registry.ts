// Cross-boundary handoff for the `tailers` plugin contribution (v0.8.2).
//
// The plugin loader lives in `src/core/plugins/` and cannot import from
// `src/main/services/tailer-host.ts` (main → core is fine, core → main is
// the wrong direction — main-only code doesn't exist in test/renderer
// bundles). Instead, main wires itself in at startup via
// `setTailerContributionSink(...)`, and `contributions.ts` calls
// `contributeTailer(...)` / `withdrawTailer(...)` without knowing where
// those calls land.
//
// This is intentionally duck-typed (`TailerLike`) so core has no compile
// dependency on the host's `TailerAdapter` interface. The sink casts.

export interface TailerLike {
  /** Stable identifier (e.g. `claude-code`, `codex`, `opencode`). Used by
   *  the host to key the internal registry. */
  agentKind: string
}

type RegisterFn = (pluginId: string, adapter: TailerLike) => void
type UnregisterFn = (pluginId: string) => void

let register: RegisterFn | null = null
let unregister: UnregisterFn | null = null

/** Called by main-process bootstrap. Passes callbacks that translate a
 *  plugin's tailer contribution into `registerAdapter` / `unregisterAdapter`
 *  on the host. If never called (headless test), tailer contributions are
 *  silently dropped — no crash. */
export function setTailerContributionSink(reg: RegisterFn, unreg: UnregisterFn): void {
  register = reg
  unregister = unreg
}

/** Called from `contributions.ts::applyContributions` after successfully
 *  loading the plugin's tailer module. No-op when no sink is attached. */
export function contributeTailer(pluginId: string, adapter: TailerLike): void {
  if (register) register(pluginId, adapter)
}

/** Called from `contributions.ts::removeContributions` on unload. */
export function withdrawTailer(pluginId: string): void {
  if (unregister) unregister(pluginId)
}

/** Test-only. Reset the sink so a fresh test can attach its own hooks. */
export function _resetTailerSinkForTest(): void {
  register = null
  unregister = null
}
