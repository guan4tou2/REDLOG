import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome } from './helpers'

// #588: the authorised targets can be written on the create card, and they are
// the project's scope from its first event — no trip through Settings.
test.describe('create a project with a scope', () => {
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

  test('the targets typed on the card are saved as the scope', async () => {
    await page.getByRole('button', { name: 'New Project' }).click()
    await page.getByPlaceholder('e.g. Client-Pentest-Q3').fill('Scope On Create')
    const targets = page.getByLabel('Targets (IPs, CIDRs, *.domain)')
    await targets.fill('203.0.113.0/24 *.lab.test')
    await targets.locator('..').getByRole('button', { name: 'Add' }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'dashboard')

    const scope = await page.evaluate(async () =>
      (await (window as unknown as { redlog: { config: { get: () => Promise<{ scope: { targets: string[]; excludeTargets: string[] } }> } } }).redlog.config.get()).scope)
    expect(scope.targets).toEqual(['203.0.113.0/24', '*.lab.test'])
    expect(scope.excludeTargets).toEqual([])
  })
})
