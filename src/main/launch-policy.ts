// What a packaged RedLog drops from its own launch before the app is ready.
// Pure: index.ts applies it with app.commandLine.removeSwitch and by deleting
// the env keys. Dev and unpackaged e2e launches get an empty policy.
//
// Applied:
// - --js-flags: V8 flags. The main process's V8 has already read them when any
//   JS runs; removing the switch keeps them from being copied to renderers.
// - --remote-debugging-pipe: read when the browser starts its DevTools handler,
//   after the main script has run, so removing it here is in time.
// - REDLOG_KEYS_DIR: a unit-test seam (signing.ts) that moves the operator's
//   signing keys. Read at call time, so deleting it here is in time.
//
// Not applied, because e2e/packaged-*.spec.ts launches the packaged app through
// Playwright, which needs them: --remote-debugging-port and --inspect (passed
// by electron.launch itself) and REDLOG_E2E / REDLOG_E2E_HIDE_HUD. The
// --inspect family cannot be refused from here in any case: Node starts the
// inspector before the main script runs (the EnableNodeCliInspectArguments
// fuse is what stops it).

const PACKAGED_REMOVED_SWITCHES = ['js-flags', 'remote-debugging-pipe']
const PACKAGED_CLEARED_ENV = ['REDLOG_KEYS_DIR']

export interface LaunchPolicy {
  /** Switch names, without dashes, for app.commandLine.removeSwitch. */
  removeSwitches: string[]
  /** Environment keys to delete from process.env. */
  clearEnv: string[]
  /** What the launch actually carried, for the debug log. */
  dropped: string[]
}

export function launchPolicy(argv: readonly string[], env: NodeJS.ProcessEnv, isPackaged: boolean): LaunchPolicy {
  if (!isPackaged) return { removeSwitches: [], clearEnv: [], dropped: [] }
  const present = (name: string): boolean => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  const clearEnv = PACKAGED_CLEARED_ENV.filter((k) => env[k] !== undefined)
  return {
    removeSwitches: [...PACKAGED_REMOVED_SWITCHES],
    clearEnv,
    dropped: [...PACKAGED_REMOVED_SWITCHES.filter(present).map((s) => `--${s}`), ...clearEnv]
  }
}
