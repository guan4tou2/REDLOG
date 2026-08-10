import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchWithTempHome, openTestProject, type RedLogBridge } from './helpers'

const SCREENSHOT_DIR = join(__dirname, 'screenshots')

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
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('creates a project and opens the dashboard', async () => {
    // Fresh HOME → no projects yet, so ProjectPicker owns the window.
    await expect(page.locator('[data-testid="project-picker"]')).toBeVisible()

    const project = await openTestProject(page, 'e2e-flow')
    expect(project.name).toBe('e2e-flow')
    expect(project.id).toBeTruthy()

    // openTestProject already waits for view-root; assert once more for the
    // explicit "we're on the dashboard now" story this test tells.
    const viewRoot = page.locator('[data-testid="view-root"]')
    await expect(viewRoot).toHaveAttribute('data-view', 'dashboard')

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'project-opened.png') })
  })

  test('⌘1..9 switches views (v0.6.67 focus fix)', async () => {
    // Default sidebar order: dashboard, timeline, transcript, terminal,
    // screenshots, targets, scope, loot, marks. The sidebar takes 1..8 and
    // ⌘9 is pinned to settings (v0.11.2) — before that the two were one
    // concatenated list, so adding a ninth sidebar entry pushed settings past
    // the reachable digits and it silently lost its shortcut.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const viewRoot = page.locator('[data-testid="view-root"]')

    for (const [key, expected] of [
      ['2', 'timeline'],
      ['3', 'transcript'],
      ['4', 'terminal'],
      ['1', 'dashboard'],
      ['9', 'settings']
    ] as const) {
      await page.keyboard.press(`${mod}+${key}`)
      await expect(viewRoot).toHaveAttribute('data-view', expected, { timeout: 2_000 })
    }
  })

  test('chain.verify({ full: true }) is ok on a fresh project', async () => {
    // A freshly opened project has only system events (api_started,
    // session_start, …) appended by the main process. Those are hashed into
    // the chain the same way user events are, so full verify should pass.
    const result = await page.evaluate(async () => {
      const bridge = (window as unknown as { redlog: RedLogBridge }).redlog
      return await bridge.chain.verify({ full: true })
    })
    // eslint-disable-next-line no-console
    console.log('chain.verify result:', JSON.stringify(result))
    expect(result.ok).toBe(true)
    // verifyChainFull returns `brokenAtEventId: null` when the walk is clean;
    // treat undefined and null as the same "no break" signal so we don't
    // depend on that internal choice.
    expect(result.brokenAtEventId ?? null).toBeNull()
  })
})
