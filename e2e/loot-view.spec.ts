import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

test('Loot discloses and traverses a recent subset', async () => {
  test.setTimeout(180_000)
  const tmpHome = makeTempHome('redlog-loot-')
  const app = await electron.launch({
    args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'loot-completeness')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

    for (let start = 0; start < 205; start += 25) {
      await Promise.all(Array.from({ length: Math.min(25, 205 - start) }, (_, offset) => {
        const i = start + offset
        return fetch(`${base}/api/events/seed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            agent_type: 'loot',
            target_id: '10.10.10.10',
            data: { source: 'e2e', matches: [{ type: 'generic_api_key', confidence: 'high', preview: `loot-secret-${i}` }] }
          })
        }).then((response) => {
          if (!response.ok) throw new Error(`seed failed: ${response.status}`)
        })
      }))
    }

    await openView(page, 'loot')
    await expect(page.getByTestId('loot-completeness')).toContainText('Recent subset')
    await page.getByRole('button', { name: 'Load older loot' }).click()
    await expect(page.getByTestId('loot-completeness')).toContainText('Complete loaded set')
    await expect(page.getByText('loot-secret-0')).toBeAttached()
  } finally {
    await app.close()
  }
})
