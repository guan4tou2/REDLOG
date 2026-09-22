import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

test('Search executes and explains the shared event query contract', async () => {
  test.setTimeout(180_000)
  const tmpHome = makeTempHome('redlog-search-contract-')
  const app = await electron.launch({
    args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'search-contract')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type: 'agent', data: {
        subtype: 'assistant_message', agent: 'codex', session_id: 'session-e2e', full: 'contract evidence'
      } })
    })

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('session:session-e2e contract')
    await expect(page.getByTestId('search-query-parse')).toContainText('session:session-e2e')
    await expect(page.getByRole('option')).toContainText('contract evidence')
  } finally {
    await app.close()
  }
})
