import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

test('Search finds text that exists only in an externalized HTTP body', async () => {
  test.setTimeout(120_000)
  const tmpHome = makeTempHome('redlog-body-search-')
  const app = await electron.launch({
    args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'http-body-search')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const marker = 'BODY-ONLY-MARKER-77219'
    const response = await fetch(`${base}/api/events/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent_type: 'scanner', target_id: 'body-search.test',
        data: {
          subtype: 'http_response', flow_id: 'body-search-flow', status: 200,
          url: 'https://body-search.test/result',
          response_body: { data: `${'x'.repeat(5000)} ${marker}`, encoding: 'text', size: 5024, sha256: 'producer-value' }
        }
      })
    })
    expect(response.ok).toBe(true)

    await openView(page, 'search')
    await page.getByTestId('search-input').fill(marker)
    await expect(page.getByText('body-search.test')).toBeVisible()
    await expect(page.getByText(/scanner:/)).toBeVisible()
    await expect(page.getByTestId('search-error')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
