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

  // The menu is `absolute top-7` inside a 40px title bar, so an
  // `overflow-hidden` on that strip cuts it off after its first row. It
  // shipped that way and read as a broken component: one checkbox and then
  // nothing, with the cut landing exactly on the title bar's bottom border.
  //
  // Clicking is not the test. `overflow: hidden` is still scrollable
  // programmatically, so Playwright's scroll-into-view brings a clipped option
  // back before it clicks — the existing tests above pressed the format
  // buttons happily while a person could not see them. What a person sees is
  // whether an ancestor's box ends above the panel's, so that is what this
  // asks. Every measurement here is a client rect: mixing rects with `offset*`
  // under `body { zoom }` compares device pixels against CSS ones.
  test('opens the menu without an ancestor clipping it', async () => {
    await page.getByLabel('Export').click()
    const panel = page.getByTestId('export-menu')
    await expect(panel).toBeVisible()
    const cutBy = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="export-menu"]') as HTMLElement | null
      if (!el) return 'the menu is not in the document'
      const panelBottom = el.getBoundingClientRect().bottom
      for (let a = el.parentElement; a; a = a.parentElement) {
        const style = getComputedStyle(a)
        if (style.position === 'fixed') break
        if (!/hidden|clip|auto|scroll/.test(`${style.overflow} ${style.overflowY}`)) continue
        const box = a.getBoundingClientRect()
        // A pixel of slack: a border or a fractional layout is not a clip.
        if (box.bottom < panelBottom - 1) return `${a.className.slice(0, 80)} ends at ${box.bottom}, menu at ${panelBottom}`
      }
      return null
    })
    expect(cutBy).toBeNull()
    await page.keyboard.press('Escape')
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
