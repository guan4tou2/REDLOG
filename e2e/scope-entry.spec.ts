import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome } from './helpers'

test.describe.serial('scope entry and project identity', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
  })
  test.afterAll(async () => { if (app) await app.close() })

  test('takes excludes in Settings and keeps the engagement ID read-only', async () => {
    // Spec 037 put excludes on the create card. They came off it: Settings ▸
    // Scope already owned them, and the create card was asking for a boundary
    // before the operator had seen a single event — the necessity test's third
    // question, answered by another surface that was already there.
    await page.getByPlaceholder('e.g. Client-Pentest-Q3').fill('Scope Lab')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'dashboard')

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    await page.click('[data-settings-page="scope"]')
    // By its own placeholder: the page has three list fields and the labels
    // carry no `for`, so this is the one hook that names the exclude box
    // rather than the targets box above it.
    const excludeBox = page.getByPlaceholder('e.g. 10.0.0.1')
    await excludeBox.fill('127.0.0.1')
    // Commit with the button, not Enter. A validating list field takes a
    // paste, and the requirement splits it on newlines — so it is a textarea
    // where Enter stays a newline and ⌘/Ctrl+Enter or `+` commits.
    await excludeBox.locator('..').getByRole('button', { name: 'Add' }).click()

    const readConfig = (): Promise<{ engagement: { id: string }; scope: { excludeTargets: string[] } }> =>
      page.evaluate(() =>
        (window as unknown as { redlog: { config: { get: () => Promise<{ engagement: { id: string }; scope: { excludeTargets: string[] } }> } } }).redlog.config.get()
      )
    // Settings autosaves on a debounce, so the assertion polls rather than
    // reading once and racing it.
    await expect.poll(async () => (await readConfig()).scope.excludeTargets).toEqual(['127.0.0.1'])
    const config = await readConfig()

    // Already in Settings from the excludes above; move to the page that
    // shows the engagement identity. By its stable id, not its visible text —
    // that label has been reworded once already.
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'settings')
    await page.click('[data-settings-page="general"]')
    const id = page.getByLabel('ID', { exact: true }).first()
    await expect(id).toHaveValue(config.engagement.id)
    await expect(id).toHaveAttribute('readonly', '')

    const savedId = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { config: { get: () => Promise<any>; save: (config: any) => Promise<boolean> } } }).redlog.config
      const current = await api.get()
      current.engagement.id = 'attempted-rewrite'
      await api.save(current)
      return (await api.get()).engagement.id as string
    })
    expect(savedId).toBe(config.engagement.id)
  })
})
