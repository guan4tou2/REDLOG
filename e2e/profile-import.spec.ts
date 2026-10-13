import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome } from './helpers'

// #297, on the real app. The unit tests hold the resolver; what they cannot
// show is the path the operator takes: pick a file, read the summary under the
// button, press Create, and be left with exactly what the summary said — then
// close the project, open it again, and still have it.
//
// The native file picker is the one thing replaced: `dialog.showOpenDialog` in
// the main process answers with a fixture path. Everything after it — the IPC,
// the file read, the React card, project.create, the config written to disk and
// read back — is the shipped code. The picker itself is not exercised here.

interface Cfg {
  scope: { targets: string[]; excludeTargets: string[]; warnOnViolation: boolean }
  network: { whitelist: string[]; blacklist: string[] }
}
interface Bridge {
  config: { get: () => Promise<Cfg> }
  project: {
    active: () => Promise<{ id: string; name: string } | null>
    open: (id: string) => Promise<{ id: string; name: string } | null>
    close: () => Promise<unknown>
  }
}

// The UI is English or Chinese depending on the machine; the specs match both
// rather than depend on which.
const IMPORT = /Import Profile|匯入設定檔/
const CREATE = /^(Create|建立)$/
const CLEAR = /Clear imported settings|清除已匯入的設定/
const EXCLUDED = /Excluded|排除/
const NO_WARN = /No warning on out-of-scope|不警告範圍外目標/
const NOTHING_DIFFERS = /nothing differs|內容與預設值相同/

test.describe.serial('profile import on the create-project card (#297)', () => {
  let app: ElectronApplication
  let page: Page
  let home: string
  let n = 0

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    home = launched.tmpHome
    // Under xvfb the first load of a fresh window can produce no animation
    // frames at all — measured on Linux: 0 requestAnimationFrame callbacks in
    // 3 s, the CSS transitions "running" and never advancing, and neither
    // focusing a field nor waiting changes it. Playwright's click waits for the
    // target to be stable across two frames, so a spec whose first action is a
    // click waited out its whole timeout on ubuntu CI while passing on
    // Windows. A reload is what restores them (~74 frames/s) and is what the
    // specs that click after launch already do (scope-entry, openTestProject).
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('project-picker')).toBeVisible()
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  /** The next file the picker will hand back, or a cancel. */
  async function pickerReturns(result: { filePath: string } | 'cancel'): Promise<void> {
    await app.evaluate(({ dialog }, r) => {
      dialog.showOpenDialog = (async () =>
        r === 'cancel' ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [r.filePath] }
      ) as typeof dialog.showOpenDialog
    }, result)
  }

  async function importFile(body: string, ext: 'json' | 'yaml' = 'json'): Promise<void> {
    const filePath = join(home, `profile-${++n}.${ext}`)
    writeFileSync(filePath, body)
    await pickerReturns({ filePath })
    await page.getByRole('button', { name: IMPORT }).click()
  }

  const applied = (): ReturnType<Page['locator']> => page.getByTestId('profile-applied')
  const failure = (): ReturnType<Page['locator']> => page.getByTestId('profile-error')

  async function config(): Promise<Cfg> {
    return page.evaluate(() => (window as unknown as { redlog: Bridge }).redlog.config.get())
  }

  /** Press Create with this name; resolves on the project's dashboard. */
  async function createProject(name: string): Promise<Cfg> {
    await page.getByTestId('project-picker').locator('input').first().fill(name)
    await page.getByRole('button', { name: CREATE }).click()
    await page.waitForSelector('[data-testid="view-root"]', { timeout: 15_000 })
    return config()
  }

  /** Leave the open project and be back on the card with nothing imported. */
  async function backToPicker(): Promise<void> {
    await page.evaluate(() => (window as unknown as { redlog: Bridge }).redlog.project.close())
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('project-picker')).toBeVisible({ timeout: 10_000 })
  }

  test.beforeEach(async () => {
    await expect(page.getByTestId('project-picker')).toBeVisible({ timeout: 10_000 })
  })

  test('A then B: the project is B, not A and B', async () => {
    await importFile(JSON.stringify({ scope: { targets: ['192.0.2.0/24'], excludeTargets: ['192.0.2.9'] } }))
    await expect(applied()).toContainText(EXCLUDED)

    await importFile(JSON.stringify({ scope: { targets: ['198.51.100.0/24'] } }))
    // The card says one scope entry and NO exclusion — it no longer carries A's.
    await expect(applied()).toContainText(/Scope 1|範圍 1/)
    await expect(applied()).not.toContainText(EXCLUDED)

    const cfg = await createProject('a-then-b')
    expect(cfg.scope.targets).toEqual(['198.51.100.0/24'])
    expect(cfg.scope.excludeTargets).toEqual([])

    // And it is what was saved, not what was on screen: close the project, open
    // it again, and read it back.
    const id = (await page.evaluate(() => (window as unknown as { redlog: Bridge }).redlog.project.active()))!.id
    await backToPicker()
    const reopened = await page.evaluate(async (pid) => {
      const b = (window as unknown as { redlog: Bridge }).redlog
      await b.project.open(pid)
      return b.config.get()
    }, id)
    expect(reopened.scope.targets).toEqual(['198.51.100.0/24'])
    expect(reopened.scope.excludeTargets).toEqual([])
    await backToPicker()
  })

  test('B then A, and the same file twice, give the same project each time', async () => {
    await importFile(JSON.stringify({ scope: { targets: ['198.51.100.0/24'] } }))
    await importFile(JSON.stringify({ scope: { targets: ['192.0.2.0/24'], excludeTargets: ['192.0.2.9'] } }))
    await importFile(JSON.stringify({ scope: { targets: ['192.0.2.0/24'], excludeTargets: ['192.0.2.9'] } }))
    await expect(applied()).toContainText(EXCLUDED)

    const cfg = await createProject('b-then-a')
    expect(cfg.scope.targets).toEqual(['192.0.2.0/24'])
    expect(cfg.scope.excludeTargets).toEqual(['192.0.2.9'])
    await backToPicker()
  })

  test('a profile that only turns the warning off is saved', async () => {
    await importFile(JSON.stringify({ scope: { warnOnViolation: false } }))
    await expect(applied()).toContainText(NO_WARN)

    const cfg = await createProject('warn-off')
    expect(cfg.scope.warnOnViolation).toBe(false)
    expect(cfg.scope.targets).toEqual([])
    await backToPicker()
  })

  test('exclusions with no scope, and an explicitly empty list, are both applied as written', async () => {
    await importFile(JSON.stringify({ scope: { excludeTargets: ['203.0.113.7'] } }))
    const a = await createProject('exclude-only')
    expect(a.scope.excludeTargets).toEqual(['203.0.113.7'])
    expect(a.scope.targets).toEqual([])
    await backToPicker()

    await importFile(JSON.stringify({ scope: { targets: [] } }))
    await expect(applied()).toContainText(NOTHING_DIFFERS)
    const b = await createProject('empty-list')
    expect(b.scope.targets).toEqual([])
    expect(b.scope.warnOnViolation).toBe(true)
    await backToPicker()
  })

  test('YAML is read the same way as JSON', async () => {
    await importFile('scope:\n  targets:\n    - 10.9.0.0/16\n  warnOnViolation: false\n', 'yaml')
    await expect(applied()).toContainText(/Scope 1|範圍 1/)
    await expect(applied()).toContainText(NO_WARN)
    const cfg = await createProject('yaml-profile')
    expect(cfg.scope.targets).toEqual(['10.9.0.0/16'])
    expect(cfg.scope.warnOnViolation).toBe(false)
    await backToPicker()
  })

  test('clearing the import leaves a project with the defaults', async () => {
    await importFile(JSON.stringify({ scope: { targets: ['198.51.100.0/24'], warnOnViolation: false } }))
    await expect(applied()).toBeVisible()
    await page.getByRole('button', { name: CLEAR }).click()
    await expect(applied()).toHaveCount(0)

    const cfg = await createProject('cleared')
    expect(cfg.scope.targets).toEqual([])
    expect(cfg.scope.warnOnViolation).toBe(true)
    await backToPicker()
  })

  test('a refused file says why and leaves what was imported exactly as it was', async () => {
    await importFile(JSON.stringify({ scope: { targets: ['198.51.100.0/24'] } }))
    const before = await applied().innerText()

    // not JSON
    await importFile('{ "scope": ')
    await expect(failure()).toContainText(/not valid YAML or JSON|不是有效的 YAML 或 JSON/)
    await expect(applied()).toHaveText(before)

    // parsed, wrong type
    await importFile(JSON.stringify({ scope: { targets: 'not-a-list' } }))
    await expect(failure()).toContainText('scope.targets')
    await expect(applied()).toHaveText(before)

    // parsed, nothing a project can take
    await importFile(JSON.stringify({ somethingElse: 1 }))
    await expect(failure()).toContainText(/none of the settings|沒有新專案可採用/)
    await expect(applied()).toHaveText(before)

    // a path that is not there
    await pickerReturns({ filePath: join(home, 'does-not-exist.json') })
    await page.getByRole('button', { name: IMPORT }).click()
    await expect(failure()).toContainText(/could not be read|無法讀取/)
    await expect(applied()).toHaveText(before)

    // and the draft that survived all four is what gets created
    const cfg = await createProject('kept-draft')
    expect(cfg.scope.targets).toEqual(['198.51.100.0/24'])
    await backToPicker()
  })

  test('backing out of the picker is not an error and changes nothing', async () => {
    await importFile(JSON.stringify({ scope: { targets: ['198.51.100.0/24'] } }))
    const before = await applied().innerText()
    await pickerReturns('cancel')
    await page.getByRole('button', { name: IMPORT }).click()
    await expect(failure()).toHaveCount(0)
    await expect(applied()).toHaveText(before)

    // a good import after a refused one clears the message
    await importFile('not json at all {')
    await expect(failure()).toBeVisible()
    await importFile(JSON.stringify({ scope: { targets: ['198.51.100.0/24'] } }))
    await expect(failure()).toHaveCount(0)
  })
})
