import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
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
    verify: () => Promise<{ ok: boolean; brokenAtEventId?: string }>
  }
}

export const REPO_ROOT = join(__dirname, '..')
export const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')

/**
 * For a spec that drives the real mitmdump: skip where none is installed —
 * except in a run that says it must be there (CI's e2e job sets
 * `REDLOG_E2E_REQUIRE_MITMDUMP=1`), where a missing mitmdump fails instead.
 *
 * A skip is a green result that checked nothing. These specs skipped on every
 * CI run for as long as the job did not install mitmproxy, and nothing said so.
 */
export function requireMitmdump(): void {
  const found = spawnSync('mitmdump', ['--version'], { timeout: 10_000 }).status === 0
  if (process.env.REDLOG_E2E_REQUIRE_MITMDUMP === '1') {
    expect(found, 'REDLOG_E2E_REQUIRE_MITMDUMP=1, but `mitmdump --version` failed').toBe(true)
  }
  test.skip(!found, 'Requires installed mitmdump for real source acceptance')
}

/**
 * A fresh, isolated fake home for one Electron launch.
 *
 * Windows: `mkdtemp` hands back a bare directory, and Electron dies during
 * startup — no stderr, exit `0xC0000005` — when `%USERPROFILE%\AppData\Roaming`
 * does not exist, because Chromium resolves the roaming-appdata path before
 * any RedLog code runs. Every spec that pointed `USERPROFILE` at a bare temp
 * dir therefore failed to launch on Windows, which is why the whole e2e suite
 * was unrunnable there. Creating that one directory is the whole fix.
 */
export function makeTempHome(prefix = 'redlog-e2e-'): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  if (process.platform === 'win32') {
    mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  }
  return home
}

/**
 * Launch the built Electron app with HOME pointed at a fresh temp dir so the
 * test never touches the operator's real `~/.redlog/`. Also asserts the build
 * artifact exists so the failure message is actionable.
 */
export async function launchWithTempHome(executablePath?: string, { showHud = false, home, onLaunch }: {
  showHud?: boolean
  home?: string
  /** Called right after the process exists, before the first window — the place to attach stdout/stderr listeners that must see startup output. */
  onLaunch?: (app: ElectronApplication) => void
} = {}): Promise<{
  app: ElectronApplication
  page: Page
  tmpHome: string
}> {
  if (!executablePath && !existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Electron build output not found at ${MAIN_ENTRY}. ` +
        `Run "npm run build" before "npm run e2e".`
    )
  }
  const tmpHome = home ?? makeTempHome()
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      CLAUDE_CONFIG_DIR: join(tmpHome, '.claude'),
      CODEX_HOME: join(tmpHome, '.codex'),
      // Enables dev-only IPC endpoints used by E2E specs. The main process
      // refuses those endpoints when this flag is unset.
      REDLOG_E2E: '1',
      REDLOG_E2E_HIDE_HUD: showHud ? '0' : '1'
    }
  })
  onLaunch?.(app)
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
  const direct=page.locator(`[data-view-btn="${view}"]`).first()
  if(await direct.count())await direct.click()
  else if(['scope','loot','bookmarks'].includes(view)){
    await page.locator(`[data-view-btn="${view==='scope'?'targets':'screenshots'}"]`).first().click()
    await page.locator(`[data-view-btn="${view}"]`).click()
  }else{
    // The global palette deliberately yields to text editing. Move focus to
    // the current navigation control rather than changing that product rule.
    await page.locator('nav [aria-current="page"]').focus()
    await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k')
    await page.locator(`[data-command-id="nav:${view}"]`).click()
  }
  await page.waitForSelector(`[data-testid="view-root"][data-view="${view}"]`, { timeout: 10_000 })
}

/** Enter proof through the actual skip action if this host lacks tools.
 * This does not install a tool or count skipping as verified recording. */
/** The Timeline opens in standard mode (Spec 069 FR-008). Specs that assert
 *  on the swim-lane track ask for it by name rather than relying on a default. */
export async function openSwimLanes(page: Page): Promise<void> {
  await openView(page, 'timeline')
  const lanes = page.getByTestId('timeline-mode-lanes')
  await lanes.waitFor({ state: 'visible', timeout: 10_000 })
  if ((await lanes.getAttribute('aria-pressed')) !== 'true') await lanes.click()
  await page.getByTestId('timeline-lane-scroll').waitFor({ state: 'visible', timeout: 10_000 })
}

export async function openCaptureProof(page: Page): Promise<void> {
  const prepare = page.getByTestId('capture-prepare-skip')
  const proof = page.getByTestId('first-run-commands-status')
  await expect.poll(async () => await prepare.isVisible() || await proof.isVisible(), { timeout: 15_000 }).toBe(true)
  if (await prepare.isVisible()) {
    try { await prepare.click({ timeout: 2_000 }) }
    catch (error) {
      // A prepared host can advance automatically while Playwright waits
      // for the initial button to settle. Accept only the actual proof view.
      if (!await proof.isVisible()) throw error
    }
  }
  await expect(proof).toBeVisible()
}

/**
 * Open a Settings category.
 *
 * Settings moved from a row of eight top-level tabs to a left list of thirteen
 * categories (§10), and the specs that reached those tabs by visible text —
 * `/^data$/i`, `/^plugins$/i` — broke, because "Data" no longer exists as one
 * place: it split into retention, chain, sharing and appearance. Reach the
 * category by its stable id instead, the same way `openView` reaches a view.
 */
export async function openSettingsPage(page: Page, id: string): Promise<void> {
  // One column (#590): the list of pages, or a page with a way back to it.
  const content = page.getByTestId('settings-content')
  await expect(content).toBeVisible()
  if ((await content.getAttribute('data-page')) !== 'home') await page.getByTestId('settings-back').click()
  await page.locator(`[data-settings-page="${id}"]`).click()
  await expect(content).toHaveAttribute('data-page', id)
}

/**
 * Spec 066: official AI integrations are installed, updated and removed on the
 * Plugins page only. These walk that path and come back to Capture sources,
 * where the per-project settings still live.
 */
export async function installOfficialAgentOnPlugins(page: Page, kind: string): Promise<void> {
  await openSettingsPage(page, 'plugins')
  await page.getByTestId(`plugin-details-official-ai-${kind}`).click()
  await page.getByTestId(`plugin-install-official-ai-${kind}`).click()
  await expect(page.getByTestId(`plugin-uninstall-official-ai-${kind}`)).toBeVisible()
  await openSettingsPage(page, 'captureControl')
}

export async function removeOfficialAgentOnPlugins(page: Page, kind: string): Promise<void> {
  await openSettingsPage(page, 'plugins')
  await page.getByTestId(`plugin-details-official-ai-${kind}`).click()
  await page.getByTestId(`plugin-uninstall-official-ai-${kind}`).click()
  const removal = page.getByRole('dialog', { name: 'Remove capture integration' })
  await expect(removal).toBeVisible()
  await expect(removal).toContainText('Every project on this computer stops recording this source.')
  await expect(removal).toContainText('Records already captured are kept.')
  await removal.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByTestId(`plugin-install-official-ai-${kind}`)).toBeVisible()
  await openSettingsPage(page, 'captureControl')
}

/**
 * Resize the MAIN window.
 *
 * Not `getAllWindows()[0]`. Opening a project creates the HUD overlay as a
 * second BrowserWindow, and that array's order is not creation order — so
 * `[0]` is sometimes the overlay. Both halves of that go wrong at once and
 * neither says so:
 *
 *  - the main window never gets resized, so a spec that shrinks it to force
 *    overflow silently measures an unshrunk window and the height assertion
 *    fails on a precondition that was never established;
 *  - the overlay *does* get resized, to a frameless transparent window the
 *    size of the main one, sitting always-on-top at `screen-saver` level over
 *    whatever the operator is looking at.
 *
 * Pick the window by URL, the way `hud-overlay.spec.ts` already does.
 */
export async function resizeMainWindow(
  app: ElectronApplication,
  width: number,
  height: number
): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const main = BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('overlay'))
    if (!main) throw new Error('main window not found (only the overlay was open)')
    main.setSize(size.width, size.height)
  }, { width, height })
}

/** Check identity in the already-running app; never launch another window just
 * to inspect its build. The caller chooses where to navigate afterwards. */
export async function expectAppBuild(app: ElectronApplication, page: Page, expected?: string): Promise<void> {
  if (!expected) return
  const version = await app.evaluate(({app}) => app.getVersion())
  await openView(page,'settings')
  await openSettingsPage(page,'about')
  await expect(page.getByText(`RedLog v${version} · ${expected}`,{exact:true})).toBeVisible()
}

/** The main window's size right after launch, for `resetSharedApp` to return to. */
export async function mainWindowSize(app: ElectronApplication): Promise<[number, number]> {
  return app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('overlay'))
    if (!main) throw new Error('main window not found (only the overlay was open)')
    return main.getSize() as [number, number]
  })
}

/**
 * Put a shared Electron instance back to a known state between the describes of
 * a file that launches once: zoom, window size and localStorage (zoom level,
 * selection, dividers, locale…). Project state is not touched — each describe
 * opens its own project with `openTestProject`.
 */
export async function resetSharedApp(
  app: ElectronApplication,
  page: Page,
  size: [number, number],
  locale = 'en'
): Promise<void> {
  const win = await app.browserWindow(page)
  await win.evaluate((w) => w.webContents.setZoomFactor(1))
  await resizeMainWindow(app, size[0], size[1])
  await page.evaluate((l) => { localStorage.clear(); localStorage.setItem('redlog-locale', l) }, locale)
}
