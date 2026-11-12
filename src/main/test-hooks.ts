// The one place that reads RedLog's test-only switches (REDLOG_E2E and every
// REDLOG_E2E_*). Everything else asks the TestHooks value index.ts resolves
// here once; test/test-hooks-scan.test.ts fails on a read anywhere else.
//
// Honoured in dev and in an unpackaged e2e launch (app.isPackaged false), and
// in a packaged SMOKE build, which the install-smoke workflows drive through
// Playwright. Inert in a packaged RELEASE build, whatever the environment says.
// The variant is compiled in (electron.vite.config.ts); there is deliberately
// no run-time switch, because that switch would be the way back in.

/** True only in a main bundle built with REDLOG_SMOKE_BUILD=1. */
export const SMOKE_BUILD: boolean = typeof __REDLOG_SMOKE_BUILD__ === 'boolean' && __REDLOG_SMOKE_BUILD__

export interface TestHooks {
  /** e2e harness behaviour: temp userData, no quit prompt, the /api/events/seed route. */
  e2e: boolean
  /** Start with the HUD hidden. Implies e2e. */
  hideHud: boolean
}

export function resolveTestHooks(env: NodeJS.ProcessEnv, isPackaged: boolean, smokeBuild: boolean): TestHooks {
  const e2e = (!isPackaged || smokeBuild) && env.REDLOG_E2E === '1'
  return { e2e, hideHud: e2e && env.REDLOG_E2E_HIDE_HUD === '1' }
}
