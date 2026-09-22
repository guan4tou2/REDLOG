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

  test('creates a project with excludes and keeps engagement ID read-only', async () => {
    await page.getByPlaceholder('e.g. Client-Pentest-Q3').fill('Scope Lab')
    await page.getByText('Advanced Setup (optional)').click()
    const exclude = page.getByPlaceholder('127.0.0.1, Kali IP, or excluded CIDR')
    await exclude.fill('127.0.0.1')
    await exclude.press('Enter')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'dashboard')

    const config = await page.evaluate(async () => {
      return (window as unknown as { redlog: { config: { get: () => Promise<{ engagement: { id: string }; scope: { excludeTargets: string[] } }> } } }).redlog.config.get()
    })
    expect(config.scope.excludeTargets).toEqual(['127.0.0.1'])

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'settings')
    await page.getByRole('button', { name: 'Appearance & language' }).click()
    const id = page.getByLabel('ID').first()
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
