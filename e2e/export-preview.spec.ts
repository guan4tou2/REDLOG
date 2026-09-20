import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome, openTestProject } from './helpers'

test.describe.serial('approved export plan', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'e2e-export-plan')
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('previews and executes the same approved JSON plan', async () => {
    await page.getByLabel('Export').click()
    await page.getByText('Everything', { exact: true }).click()
    await expect(page.getByText('Plan fingerprint')).toBeVisible()
    await expect(page.getByText('Entire approved snapshot')).toBeVisible()
    await expect(page.getByText('JSON', { exact: true })).toBeVisible()
    const fingerprint = await page.getByText(/^[a-f0-9]{12}$/).textContent()
    expect(fingerprint).toMatch(/^[a-f0-9]{12}$/)
    await page.locator('button.bg-red-600').filter({ hasText: 'Export' }).click()
    await expect(page.getByText('Exported Everything')).toBeVisible()
  })

  test('rejects an approved plan after the active project changes', async () => {
    const outcome = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: {
        data: {
          resolveExportPlan: (request: { format: 'json' }) => Promise<{ ok: boolean; plan?: { id: string } }>
          executeExportPlan: (input: { planId: string }) => Promise<{ ok: boolean; error?: string }>
        }
        project: {
          create: (name: string) => Promise<{ id: string }>
          open: (id: string) => Promise<unknown>
        }
      } }).redlog
      const resolved = await api.data.resolveExportPlan({ format: 'json' })
      if (!resolved.ok || !resolved.plan) return { ok: false, error: 'resolve-failed' }
      const other = await api.project.create('e2e-export-other')
      await api.project.open(other.id)
      return api.data.executeExportPlan({ planId: resolved.plan.id })
    })
    expect(outcome).toMatchObject({ ok: false, error: 'project-changed' })
  })
})
