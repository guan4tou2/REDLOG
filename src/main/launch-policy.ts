// What a packaged RedLog drops from its own launch before the app is ready.
// Pure: index.ts applies it with app.commandLine.removeSwitch and by deleting
// the env keys. Dev and unpackaged e2e launches get an empty policy.
//
// Applied:
// - --js-flags: V8 flags. The main process's V8 has already read them when any
//   JS runs; removing the switch keeps them from being copied to renderers.
// - --remote-debugging-pipe: read when the browser starts its DevTools handler,
//   after the main script has run, so removing it here is in time.
// - --remote-debugging-port, --remote-debugging-address, --remote-allow-origins
//   (release builds only): the same. Electron loads the main script in
//   ElectronBrowserMainParts::PostEarlyInitialization and only later, in
//   PreMainMessageLoopRun, checks HasSwitch(kRemoteDebuggingPort) on the
//   process command line before starting the DevTools HTTP server — the same
//   CommandLine object removeSwitch edits. index.ts still checks the switch is
//   gone and refuses to start if it is not.
// - REDLOG_KEYS_DIR: a unit-test seam (signing.ts) that moves the operator's
//   signing keys. Read at call time, so deleting it here is in time.
//
// A smoke build (the install-smoke workflows) keeps the remote debugging port,
// which Playwright's electron.launch needs. The --inspect family cannot be
// refused from here at all: Node starts the inspector before the main script
// runs, so the EnableNodeCliInspectArguments fuse is what stops it (off in
// release builds). REDLOG_E2E* are made inert by test-hooks.ts, not here.

const PACKAGED_REMOVED_SWITCHES = ['js-flags', 'remote-debugging-pipe']
const RELEASE_REMOVED_SWITCHES = ['remote-debugging-port', 'remote-debugging-address', 'remote-allow-origins']
const PACKAGED_CLEARED_ENV = ['REDLOG_KEYS_DIR']

export interface LaunchPolicy {
  /** Switch names, without dashes, for app.commandLine.removeSwitch. */
  removeSwitches: string[]
  /** Environment keys to delete from process.env. */
  clearEnv: string[]
  /** What the launch actually carried, for the debug log. */
  dropped: string[]
}

export function launchPolicy(argv: readonly string[], env: NodeJS.ProcessEnv, isPackaged: boolean, smokeBuild: boolean): LaunchPolicy {
  if (!isPackaged) return { removeSwitches: [], clearEnv: [], dropped: [] }
  // Chromium also takes a single-dash switch; removeSwitch removes either.
  const present = (name: string): boolean => argv.some((a) => /^--?/.test(a) && (a.replace(/^--?/, '') === name || a.replace(/^--?/, '').startsWith(`${name}=`)))
  const removeSwitches = smokeBuild ? [...PACKAGED_REMOVED_SWITCHES] : [...PACKAGED_REMOVED_SWITCHES, ...RELEASE_REMOVED_SWITCHES]
  const clearEnv = PACKAGED_CLEARED_ENV.filter((k) => env[k] !== undefined)
  return {
    removeSwitches,
    clearEnv,
    dropped: [...removeSwitches.filter(present).map((s) => `--${s}`), ...clearEnv]
  }
}
