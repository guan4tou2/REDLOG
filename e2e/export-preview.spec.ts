import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, readdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject } from './helpers'

test.describe.serial('approved export plan', () => {
  let app: ElectronApplication
  let page: Page
  let tmpHome: string

  test.beforeAll(async () => {
    const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
    app = launched.app
    page = launched.page
    tmpHome = launched.tmpHome
    if (process.env.REDLOG_PACKAGED_APP) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'e2e-export-plan')
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('previews and executes the same approved JSON plan', async () => {
    await page.getByLabel('Export').click()
    await page.getByLabel('Export range', { exact: true }).selectOption('all')
    await expect(page.getByText('Plan fingerprint')).toBeVisible()
    await expect(page.getByTestId('export-preview-subset')).toHaveText('Entire approved snapshot')
    await expect(page.getByLabel('Export format')).toHaveValue('json')
    const fingerprint = await page.getByText(/^[a-f0-9]{12}$/).textContent()
    expect(fingerprint).toMatch(/^[a-f0-9]{12}$/)
    await page.locator('button.bg-red-600').filter({ hasText: 'Export' }).click()
    await expect(page.getByText('Exported Everything')).toBeVisible()
  })

  // The current export UI is a fixed dialog. Measure its actual viewport
  // bounds and hit targets; old title-bar dropdown ancestry is no longer its
  // contract. Use client rects consistently under body zoom.
  test('keeps the dialog and its actions inside the viewport', async () => {
    await page.getByLabel('Export').click()
    const panel = page.getByTestId('export-dialog')
    await expect(panel).toBeVisible()
    const fit = await panel.evaluate(el => {
      const rect = el.getBoundingClientRect()
      const confirm = el.querySelector('[data-testid="export-confirm"]')!
      const action = confirm.getBoundingClientRect()
      const hit = document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2)
      const viewport = document.documentElement
      return {
        inside: rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.clientWidth && rect.bottom <= viewport.clientHeight,
        actionInside: action.bottom <= rect.bottom && action.top >= rect.top,
        clickable: confirm === hit || confirm.contains(hit)
      }
    })
    expect(fit).toEqual({ inside: true, actionInside: true, clickable: true })
    await page.keyboard.press('Escape')
  })

  test('keeps the focused attachment above the action bar in a small window', async () => {
    const project = await page.evaluate(async () => {
      const active = await window.redlog.project.active()
      return (await window.redlog.project.list()).find(p => p.id === active?.id)!
    })
    mkdirSync(join(project.path, 'artifacts'), { recursive: true })
    writeFileSync(join(project.path, 'artifacts', 'focus.txt'), 'focus evidence')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const seeded = await fetch(base + '/api/events/seed', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()}` },
      body: JSON.stringify({ agent_type: 'file_transfer', data: { subtype: 'artifact_added', stored: 'artifacts/focus.txt' } })
    })
    expect(seeded.ok).toBe(true)
    const win = await app.browserWindow(page)
    await win.evaluate(w => w.setSize(800, 850))
    await page.getByLabel('Export', { exact: true }).click()
    await page.getByLabel('Export format', { exact: true }).selectOption('bundle')
    const checkbox = page.getByLabel('artifacts/focus.txt', { exact: true })
    await checkbox.focus()
    await page.keyboard.press('Space')
    await expect(checkbox).not.toBeChecked()
    await expect(checkbox).toBeFocused()
    const visible = await checkbox.evaluate(el => {
      const actions = document.querySelector('[data-testid="export-confirm"]')!.parentElement!
      const rect = el.getBoundingClientRect()
      return rect.top >= 0 && rect.bottom <= actions.getBoundingClientRect().top + 1
    })
    expect(visible, 'focused attachment is covered by the action bar').toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('Export', { exact: true })).toBeFocused()
  })

  test('keeps a failed write visible and retries the selection without losing source evidence', async () => {
    test.skip(process.platform === 'win32', 'This case uses POSIX directory permissions; Windows ACL acceptance is separate')
    const project = await page.evaluate(async () => {
      const active = await window.redlog.project.active()
      return (await window.redlog.project.list()).find(p => p.id === active?.id)!
    })
    const exports = join(project.path, 'exports')
    mkdirSync(exports, { recursive: true })
    const mode = statSync(exports).mode & 0o777
    const filesBefore = readdirSync(exports).sort()
    const evidenceBefore = await page.evaluate(async () => (await window.redlog.events.query({ limit: -1 })).map(e => e.id))
    await page.getByLabel('Export', { exact: true }).click()
    await page.getByLabel('Export format', { exact: true }).selectOption('json')
    await page.getByLabel('Export range', { exact: true }).selectOption('all')
    await expect(page.getByTestId('export-confirm')).toBeEnabled()
    try {
      chmodSync(exports, 0o555)
      await page.getByTestId('export-confirm').click()
      const error = page.getByTestId('export-run-error')
      await expect(error).toContainText(/EACCES|permission denied/i)
      await expect(page.getByTestId('export-dialog')).toBeVisible()
      await expect(page.getByLabel('Export format', { exact: true })).toHaveValue('json')
      await expect(page.getByLabel('Export range', { exact: true })).toHaveValue('all')
      expect(readdirSync(exports).sort()).toEqual(filesBefore)
      chmodSync(exports, mode)
      await error.getByRole('button').click()
      await expect(error).toHaveCount(0)
      await expect(page.getByTestId('export-confirm')).toBeEnabled()
      await page.getByTestId('export-confirm').click()
      await expect(page.getByTestId('export-dialog')).toHaveCount(0)
      const newFiles = readdirSync(exports).filter(f => !filesBefore.includes(f) && f.endsWith('.json') && !f.endsWith('.manifest.json'))
      expect(newFiles).toHaveLength(1)
      const delivered = JSON.parse(readFileSync(join(exports, newFiles[0]), 'utf8'))
      const manifest = JSON.parse(readFileSync(join(exports, `${newFiles[0]}.manifest.json`), 'utf8'))
      expect(delivered.exportPlan.fingerprint).toBe(manifest.exportPlan.fingerprint)
      expect(delivered.events.length).toBe(manifest.actualCounts.included)
      const evidenceAfter = await page.evaluate(async () => (await window.redlog.events.query({ limit: -1 })).map(e => e.id))
      for (const id of evidenceBefore) expect(evidenceAfter).toContain(id)
    } finally { chmodSync(exports, mode) }
  })

  test('refuses a missing approved attachment and keeps it selected after recovery', async () => {
    const project = await page.evaluate(async () => {
      const active = await window.redlog.project.active()
      return (await window.redlog.project.list()).find(p => p.id === active?.id)!
    })
    const artifact = join(project.path, 'artifacts', 'focus.txt')
    const held = artifact + '.held'
    const original = readFileSync(artifact)
    await page.getByLabel('Export', { exact: true }).click()
    await page.getByLabel('Export format', { exact: true }).selectOption('bundle')
    await page.getByLabel('Export range', { exact: true }).selectOption('all')
    const checkbox = page.getByLabel('artifacts/focus.txt', { exact: true })
    await checkbox.check()
    await expect(page.getByTestId('export-confirm')).toBeEnabled()
    try {
      renameSync(artifact, held)
      await page.getByTestId('export-confirm').click()
      const error = page.getByTestId('export-run-error')
      await expect(error).toContainText('source-unavailable')
      await expect(page.getByTestId('export-dialog')).toBeVisible()
      renameSync(held, artifact)
      await error.getByRole('button').click()
      await expect(error).toHaveCount(0)
      await expect(checkbox).toBeChecked()
      await expect(page.getByTestId('export-confirm')).toBeEnabled()
      expect(readFileSync(artifact)).toEqual(original)
      await page.keyboard.press('Escape')
    } finally { if (existsSync(held)) renameSync(held, artifact) }
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
