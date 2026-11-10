import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchWithTempHome, openTestProject, openView, openSettingsPage, installOfficialAgentOnPlugins, resizeMainWindow } from './helpers'

// #590 / #435: a warning on the dashboard names its source, and the link opens
// Settings on that source's row — not on the page that holds it. The recovery
// that follows is the real one: point the source at a folder that exists, turn
// it back on, and a new conversation arrives as an event.

const line = (value: unknown): string => JSON.stringify(value) + '\n'

test('dashboard warning opens the source row; repairing it brings a new event', async () => {
  test.setTimeout(90_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    const work = join(tmpHome, 'client-work')
    const root = join(tmpHome, 'claude-elsewhere')
    mkdirSync(work, { recursive: true }); mkdirSync(join(root, 'fixture'), { recursive: true })
    const transcript = join(root, 'fixture', 'client.jsonl')
    writeFileSync(transcript, line({ type: 'user', uuid: randomUUID(), cwd: work, message: { role: 'user', content: [] } }))
    const user = (text: string): string => line({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] } })
    const rows = (): Promise<Array<{ data: Record<string, unknown> }>> => page.evaluate(() => window.redlog.events.query({ agentType: 'agent', limit: 1000 }))
    const agentState = (): Promise<string | undefined> => page.evaluate(async () => (await window.redlog.capture.health()).sources.find(s => s.id === 'agent-claude-code')?.state)

    await openTestProject(page, 'source-deep-link')
    await openView(page, 'settings'); await openSettingsPage(page, 'captureControl')
    await installOfficialAgentOnPlugins(page, 'claude-code')
    // Authorised and on, but the default transcript folder does not exist in
    // this home: the source tried and could not, which is what the card warns about.
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, work)
    await page.getByTestId('agent-add-path-claude-code').click()
    await page.getByTestId('agent-enabled-claude-code').check()
    await expect.poll(agentState, { timeout: 15_000 }).toBe('error')

    // The warning, on the dashboard, carries its own link.
    await openView(page, 'dashboard')
    // Core capture is not verified yet, so the dashboard is the first-run view,
    // which keeps the capture card behind a toggle.
    await page.getByRole('button', { name: 'Prepare other capture sources (AI agents, screenshots)' }).click()
    const link = page.getByTestId('capture-open-agent-claude-code')
    await expect(link).toBeVisible()
    await link.click()
    const content = page.getByTestId('settings-content')
    await expect(content).toHaveAttribute('data-page', 'captureControl')
    const row = page.getByTestId('agent-source-claude-code')
    await expect(row).toBeFocused()
    await expect(row).toBeInViewport()

    // Repair on that row: another folder, then back on (a changed source asks again).
    await page.getByTestId('agent-details-claude-code').locator('summary').click()
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, root)
    await page.getByTestId('agent-source-path-claude-code').click()
    await expect(page.getByTestId('agent-root-claude-code')).toHaveText(root)
    await page.getByTestId('agent-enabled-claude-code').check()
    await expect.poll(async () => (await rows()).some(e => e.data.subtype === 'transcript_capture_started'), { timeout: 15_000 }).toBe(true)
    expect(await agentState()).not.toBe('error')
    appendFileSync(transcript, user('DEEP_LINK_RECOVERED_SENTINEL'))
    await expect.poll(async () => JSON.stringify(await rows()), { timeout: 15_000 }).toContain('DEEP_LINK_RECOVERED_SENTINEL')
  } finally { await app.close() }
})

test('an empty Screenshots view opens the screenshot group, scrolled to and focused', async () => {
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openTestProject(page, 'screenshot-deep-link')
    // Short enough that the group is below the fold when the page opens.
    await resizeMainWindow(app, 900, 520)
    await openView(page, 'screenshots')
    await page.getByRole('button', { name: 'Periodic capture settings →' }).click()
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-page', 'captureControl')
    const group = page.locator('[data-source-id="screenshot"]')
    await expect(group).toBeFocused()
    await expect(group).toBeInViewport()
    // Landing is one-off: asking for the page again without a source does not move focus.
    await openView(page, 'dashboard'); await openView(page, 'settings')
    await expect(page.getByTestId('settings-content')).toBeVisible()
    await openSettingsPage(page, 'captureControl')
    await expect(group).not.toBeFocused()
  } finally { await app.close() }
})
