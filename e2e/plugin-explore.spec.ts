import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, openSettingsPage, resizeMainWindow, makeTempHome } from './helpers'
import en from '../src/renderer/src/i18n/en.json'

// Spec 065 batch A journey: search → needs-attention filter → detail (full
// contribution report) → back, in both the wide (list + detail) and narrow
// (detail replaces the list) layouts.
//
// Two user plugins are seeded into the temp home before launch so the whole
// trip is deterministic: one with a broken loot rule (attention: some
// contributions rejected) and one with a clean report. The bundled plugins
// load too, but the assertions below always address the seeded rows by id.

const enT = (key: string): string => (en as unknown as Record<string, string>)[key] ?? key

/** One user plugin at <home>/.redlog/plugins/<id>/plugin.json, declarative. */
function seedPlugin(home: string, id: string, name: string, contributes: Record<string, unknown>): void {
  const dir = join(home, '.redlog', 'plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    id,
    name,
    version: '1.0.0',
    description: `e2e fixture: ${name}`,
    author: 'e2e',
    redlogApi: 1,
    contributes
  }, null, 2))
}

test.describe('plugin explore & manage — batch A journey', () => {
  test('search, filter, read the report and switch layouts on a real app', async () => {
    test.setTimeout(120_000)
    const home = makeTempHome('redlog-e2e-plugins-')
    // A broken regex is rejected at apply time, so this plugin needs attention.
    seedPlugin(home, 'e2e-loot', 'Journey Scanner', {
      lootPatterns: [
        { type: 'ticket', pattern: 'TKT-[0-9]+', name: 'ticket-ok' },
        { type: 'ticket', pattern: '([unclosed', name: 'ticket-broken' }
      ]
    })
    seedPlugin(home, 'e2e-clean', 'Quiet Pack', {
      lootPatterns: [{ type: 'ticket', pattern: 'ORD-[0-9]+', name: 'order-ok' }]
    })
    // Nothing declared means no contribution report existed — a state that must
    // read as "no diagnosis yet" on the real page, never as "all accepted".
    seedPlugin(home, 'e2e-empty', 'Hollow Pack', {})

    const { app, page } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP, { home })
    const win = await app.browserWindow(page)
    try {
      // The default locale is the operator's system one; pin it to English so
      // the journey can assert on en.json strings. `openTestProject` reloads,
      // which is what makes the localStorage value take effect.
      await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
      await openTestProject(page, 'plugin-explore')
      await win.evaluate((w) => w.webContents.setZoomFactor(1))
      await resizeMainWindow(app, 1400, 900)
      await openView(page, 'settings')
      await openSettingsPage(page, 'plugins')

      // One column at every width: it starts with the list and how to open a plugin.
      await expect(page.getByTestId('plugin-details-e2e-loot')).toBeVisible()
      await expect(page.getByTestId('plugin-details-e2e-clean')).toBeVisible()
      await expect(page.getByTestId('plugin-shown-count')).toContainText(enT('plugins.listHint'))

      // Search narrows to matching rows; a miss becomes the empty-result line.
      const search = page.getByTestId('plugin-search')
      await search.fill('journey')
      await expect(page.getByTestId('plugin-details-e2e-loot')).toBeVisible()
      await expect(page.getByTestId('plugin-details-e2e-clean')).toHaveCount(0)
      await search.fill('no-such-plugin')
      await expect(page.getByText(enT('plugins.noSearchResults'))).toBeVisible()
      await search.fill('')

      // Needs-attention keeps only the row with a rejected contribution.
      await page.getByTestId('plugin-filter-attention').click()
      await expect(page.getByTestId('plugin-details-e2e-loot')).toBeVisible()
      await expect(page.getByTestId('plugin-details-e2e-clean')).toHaveCount(0)
      await page.getByTestId('plugin-filter-all').click()

      // The report lives in the detail panel: the row only carries the first
      // issue, the detail names the rejected rule and counts the rest.
      await expect(page.getByTestId('plugin-issue-e2e-loot')).toHaveText(enT('plugins.issue.partiallyEffective'))
      await page.getByTestId('plugin-details-e2e-loot').click()
      await expect(page.getByTestId('plugin-detail-e2e-loot')).toBeVisible()
      await expect(page.getByTestId('plugin-issues-e2e-loot').getByText(enT('plugins.issue.partiallyEffective'))).toBeVisible()
      const loot = page.getByTestId('plugin-results-loot-e2e-loot')
      await expect(loot).toContainText('1 accepted, 1 rejected')
      await expect(loot).toContainText('ticket-broken')
      // Trust, install and effect are read aloud; trust never becomes the only
      // word. Project and capture health belong to official integrations.
      for (const axis of ['plugins.axis.trust', 'plugins.axis.install', 'plugins.axis.effect']) {
        await expect(page.getByTestId('plugin-detail-e2e-loot')).toContainText(enT(axis))
      }
      await expect(page.getByTestId('plugin-card-capture-e2e-loot')).toHaveCount(0)

      // The detail replaces the list; Back returns to it, and a second row opens in turn.
      await expect(page.getByTestId('plugin-details-e2e-clean')).toHaveCount(0)
      await page.getByTestId('plugin-back-e2e-loot').click()
      await page.getByTestId('plugin-details-e2e-clean').click()
      await expect(page.getByTestId('plugin-detail-e2e-clean')).toBeVisible()
      await expect(page.getByTestId('plugin-detail-e2e-loot')).toHaveCount(0)
      // A plugin that declared nothing produced no report: the page says
      // "no diagnosis yet" rather than drawing a box of accepted counts.
      await page.getByTestId('plugin-back-e2e-clean').click()
      await page.getByTestId('plugin-details-e2e-empty').click()
      await expect(page.getByTestId('plugin-detail-e2e-empty')).toBeVisible()
      await expect(page.getByTestId('plugin-detail-e2e-clean')).toHaveCount(0)
      await expect(page.getByTestId('plugin-detail-e2e-empty')).toContainText(enT('plugins.unknownDiagnosis'))

      // A selection left open when the window shrinks stays on screen, and Back
      // returns to the list.
      await resizeMainWindow(app, 800, 700)
      await expect(page.getByTestId('plugin-detail-e2e-empty')).toBeVisible()
      await expect(page.getByTestId('plugin-details-e2e-empty')).toHaveCount(0)
      await expect(page.getByTestId('plugin-detail-e2e-empty').getByText(enT('plugins.back'))).toBeVisible()
      await page.getByTestId('plugin-back-e2e-empty').click()
      await expect(page.getByTestId('plugin-details-e2e-empty')).toBeVisible()
      await expect(page.getByTestId('plugin-detail-e2e-empty')).toHaveCount(0)
      // Selecting again replaces the list with the detail.
      await page.getByTestId('plugin-details-e2e-empty').click()
      await expect(page.getByTestId('plugin-detail-e2e-empty')).toBeVisible()
      await expect(page.getByTestId('plugin-details-e2e-empty')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})
