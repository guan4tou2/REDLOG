import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView } from './helpers'

test('saved terminal output is readable, searchable and saved through the Activity Reader', async () => {
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'cast-content')
    const dir = await page.evaluate(async () => {
      const active = await window.redlog.project.active()
      return (await window.redlog.project.list()).find(project => project.id === active!.id)!.path
    })
    const output = 'ABC '.repeat(500000) + 'TERMINAL-OUTPUT-MARKER'
    const cast = JSON.stringify([0, 'o', output]) + '\n'
    mkdirSync(join(dir, 'casts'), { recursive: true })
    writeFileSync(join(dir, 'casts/test.cast'), cast)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog/api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog/api-token'), 'utf8').trim()
    const response = await fetch(`${base}/api/events/seed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({agent_type:'shell',data:{subtype:'command_end',command:'cast-marker-command',command_id:'cast-command',exit_code:0,stdout_bytes:Buffer.byteLength(output),io:{stream:'cast',ref:'casts/test.cast',off:0,len:Buffer.byteLength(cast)}}}) })
    expect(response.ok).toBe(true)
    await openView(page, 'search')
    await page.getByTestId('search-input').fill('cast-marker-command')
    await page.getByTestId('activity-row').first().click()
    await page.getByTestId('activity-read').click()
    await expect(page.getByRole('option', { name: 'Terminal output (stdout and stderr combined)' })).toBeAttached()
    const search = page.getByRole('searchbox', { name: 'Find in content' })
    await search.fill('TERMINAL-OUTPUT-MARKER')
    await search.press('Enter')
    await expect(page.locator('pre mark').filter({ hasText: 'TERMINAL-OUTPUT-MARKER' })).toBeVisible()
    const destination = join(tmpHome, 'terminal-output.txt')
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, destination)
    await page.getByRole('button', { name: 'Save source content…', exact: true }).click()
    await expect.poll(() => { try { return readFileSync(destination, 'utf8') } catch { return '' } }).toBe(output)
  } finally { await app.close() }
})
