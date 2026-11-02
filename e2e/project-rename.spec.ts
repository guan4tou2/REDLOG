import { test, expect } from '@playwright/test'
import { launchWithTempHome, openTestProject, openView, openSettingsPage } from './helpers'

// Wiring of `project:rename` / `project:active` (R1b-4). ProjectRuntime's own
// rules are unit-tested; what only the real app can show is that the rename
// IPC handler tells the runtime. The title bar flips on a renderer event the
// moment Settings commits, so it proves nothing about main — a reload does: it
// re-reads `project.active()`, with the same project still open.
//
// Not covered here: a rename that arrives through an open that has already
// ended. The UI has no path to it — the field only exists while a project is
// open, and the picker rename runs with none — so the refusal stays a unit
// test (test/project-runtime.test.ts).
test('renaming the open project reaches the runtime, keeps its identity, and ends with it', async () => {
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    const project = await openTestProject(page, 'rename-before')
    const titleBar = page.getByTestId('titlebar-leave-project')
    await expect(titleBar).toContainText('rename-before')
    expect(await page.evaluate(() => window.redlog.project.active())).toMatchObject({ id: project.id, name: 'rename-before' })

    const marker = (title: string) => page.evaluate((t) => window.redlog.marker.create({ title: t, notes: '', severity: 'info', category: 'custom' }), title)
    const before = await marker('before rename')
    expect(before?.engagementId).toBe(project.id)

    // Rename the way a user does: the project's Name field in Settings, committed on blur.
    await openView(page, 'settings')
    await openSettingsPage(page, 'scope')
    const nameField = page.getByLabel('Name', { exact: true }).first()
    await expect(nameField).toHaveValue('rename-before')
    await nameField.fill('rename-after')
    await nameField.blur()

    // main answers at once: no reload, no reopen.
    await expect.poll(() => page.evaluate(() => window.redlog.project.active().then(p => p?.name))).toBe('rename-after')
    await expect(titleBar).toContainText('rename-after')
    expect(await page.evaluate(() => window.redlog.project.active())).toMatchObject({ id: project.id })

    // A fresh renderer reads the name from main; the project was never reopened.
    await page.reload()
    await page.waitForSelector('[data-testid="view-root"]', { timeout: 10_000 })
    await expect(page.getByTestId('titlebar-leave-project')).toContainText('rename-after')
    await expect(page.getByTestId('titlebar-leave-project')).not.toContainText('rename-before')

    // Same open, same identity: a row written after the rename carries the engagement of the one before.
    const after = await marker('after rename')
    expect(after?.engagementId).toBe(project.id)
    expect(after?.engagementId).toBe(before?.engagementId)
    const [stored] = await page.evaluate((id) => window.redlog.events.getById([id]), after!.id)
    expect(stored.engagementId).toBe(project.id)

    // Closing ends the open: nothing is active, and the picker lists the new name.
    await page.getByTestId('titlebar-leave-project').click()
    await page.getByRole('button', { name: 'Stop recording and leave', exact: true }).click()
    await expect(page.getByTestId('project-picker')).toBeVisible()
    expect(await page.evaluate(() => window.redlog.project.active())).toBeNull()
    await expect(page.getByText('rename-after', { exact: true })).toBeVisible()
    await expect(page.getByText('rename-before', { exact: true })).toHaveCount(0)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
  }
})
