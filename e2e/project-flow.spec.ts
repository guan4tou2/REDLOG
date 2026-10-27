import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome, type RedLogBridge } from './helpers'

// Serial + shared electronApp so the three tests reuse one ~2s launch:
// Test 1 opens a project, Tests 2 & 3 exercise it. Nothing here should run
// against the operator's real ~/.redlog — launchWithTempHome swaps HOME first.
test.describe.serial('project flow', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('repeated Enter creates only one project and opens the dashboard', async () => {
    // Fresh HOME → no projects yet, so ProjectPicker owns the window.
    await expect(page).toHaveTitle(/RedLog/)
    await expect(page.locator('[data-testid="project-picker"]')).toBeVisible()

    const name = page.getByPlaceholder('e.g. Client-Pentest-Q3')
    await name.fill('e2e-flow')
    // Deliver key repeats before IPC can answer. This exercises the real
    // picker and project store, rather than creating a project through API.
    await name.evaluate(el => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    const viewRoot = page.locator('[data-testid="view-root"]')
    await expect(viewRoot).toHaveAttribute('data-view', 'dashboard')
    const projects = await page.evaluate(() => window.redlog.project.list())
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ name: 'e2e-flow', id: expect.any(String) })

    await page.screenshot({ path: test.info().outputPath('project-opened.png') })
  })

  test('primary workspace shortcuts and pinned settings switch views', async () => {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const viewRoot = page.locator('[data-testid="view-root"]')

    for (const [key, expected] of [
      ['2', 'search'],
      ['3', 'http_history'],
      ['4', 'targets'],
      ['5', 'screenshots'],
      ['6', 'terminal'],
      ['1', 'dashboard'],
      ['9', 'settings']
    ] as const) {
      await page.keyboard.press(`${mod}+${key}`)
      await expect(viewRoot).toHaveAttribute('data-view', expected, { timeout: 2_000 })
    }
  })

  test('chain.verify() is ok on a fresh project', async () => {
    // A freshly opened project has only system events (api_started,
    // session_start, …) appended by the main process. Those are hashed into
    // the chain the same way user events are, so full verify should pass.
    const result = await page.evaluate(async () => {
      const bridge = (window as unknown as { redlog: RedLogBridge }).redlog
      return await bridge.chain.verify()
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    // verifyChainFull returns `brokenAtEventId: null` when the walk is clean;
    // treat undefined and null as the same "no break" signal so we don't
    // depend on that internal choice.
    expect(result.brokenAtEventId ?? null).toBeNull()
  })
})
