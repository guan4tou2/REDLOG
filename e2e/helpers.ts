import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Loose typing for the preload bridge — the full surface is declared in the
// renderer source (src/renderer/src/env.d.ts) but that isn't imported here.
// Only the fields we actually call from tests need to be nameable.
export interface RedLogBridge {
  project: {
    active: () => Promise<{ id: string; name: string } | null>
    create: (name: string) => Promise<{ id: string; name: string }>
    open: (id: string) => Promise<{ id: string; name: string } | null>
    list: () => Promise<Array<{ id: string; name: string; lastOpened: number }>>
  }
  chain: {
    verify: (opts?: { full?: boolean }) => Promise<{ ok: boolean; brokenAtEventId?: string }>
  }
}

export const REPO_ROOT = join(__dirname, '..')
export const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')

/**
 * Launch the built Electron app with HOME pointed at a fresh temp dir so the
 * test never touches the operator's real `~/.redlog/`. Also asserts the build
 * artifact exists so the failure message is actionable.
 */
export async function launchWithTempHome(): Promise<{
  app: ElectronApplication
  page: Page
  tmpHome: string
}> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Electron build output not found at ${MAIN_ENTRY}. ` +
        `Run "npm run build" before "npm run e2e".`
    )
  }
  const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-e2e-'))
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      // Enables dev-only IPC endpoints used by E2E specs (e.g.
      // `marketplace:testInstall` which injects a fetched tarball via bytes).
      // The main process refuses the endpoint when this flag is unset.
      REDLOG_E2E: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, tmpHome }
}

/**
 * Create and open a fresh RedLog project via the preload bridge, then wait
 * for the dashboard view to mount. Returns the new project's id + name.
 */
export async function openTestProject(
  page: Page,
  name = 'e2e-test'
): Promise<{ id: string; name: string }> {
  const project = await page.evaluate(async (n) => {
    const created = await (window as unknown as { redlog: RedLogBridge }).redlog.project.create(n)
    await (window as unknown as { redlog: RedLogBridge }).redlog.project.open(created.id)
    return { id: created.id, name: created.name }
  }, name)
  // App.tsx only reads project.active() once on mount; a reload lets that
  // effect see the now-active project and swap ProjectPicker out for the
  // main shell without needing to click through the picker UI.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('[data-testid="view-root"][data-view="dashboard"]', {
    timeout: 10_000
  })
  return project
}

/**
 * Switch to a sidebar view and wait for it to actually mount.
 *
 * Every caller used to do `page.click('button:has-text("Timeline")')` with a
 * `.catch(() => {})`, which hid two problems at once. `:has-text()` is a
 * case-insensitive *substring* match, so with a project named
 * `timeline-geometry` open, that selector also matched the title bar's
 * close-project button (`◀ timeline-geometry`) — and clicking that closed the
 * project. The swallow then turned "we are on the project picker" into a
 * failure four tests later, reported as a missing DOM node.
 *
 * So: click the stable hook, and assert the view arrived rather than hoping.
 */
export async function openView(page: Page, view: string): Promise<void> {
  await page.click(`[data-view-btn="${view}"]`)
  await page.waitForSelector(`[data-testid="view-root"][data-view="${view}"]`, { timeout: 10_000 })
}
