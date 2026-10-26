import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

test('Search opens indexed Activity output and returns from original evidence without losing the query', async ({}, testInfo) => {
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
          response_body: { data: `${'x'.repeat(128 * 1024)} ${marker}`, encoding: 'text', size: 5024, sha256: 'producer-value' }
        }
      })
    })
    expect(response.ok).toBe(true)

    await openView(page, 'search')
    await page.getByTestId('search-input').fill(marker)
    await expect(page.getByText('body-search.test')).toBeVisible()
    await expect(page.getByText(/scanner:/)).toBeVisible()
    await expect(page.getByTestId('search-error')).toHaveCount(0)
    await page.getByRole('button', { name: 'Operations', exact: true }).click()
    await expect(page.getByTestId('activity-row')).toHaveCount(1)
    await page.getByTestId('activity-row').click()
    await expect(page.getByLabel('Source event')).toBeVisible()
    await expect(page.getByRole('searchbox', { name: 'Find in content' })).toBeVisible()
    await page.getByRole('searchbox', { name: 'Find in content' }).fill(marker)
    await page.getByRole('button', { name: 'Find in content', exact: true }).click()
    await expect(page.locator('pre')).toContainText(marker)
    await expect(page.getByRole('button', { name: 'Previous window' })).toBeEnabled()
    await page.getByRole('button', { name: 'Previous window' }).click()
    await expect(page.locator('pre')).not.toContainText(marker)
    await page.getByRole('button', { name: 'Next window' }).click()
    await expect(page.locator('pre mark')).toHaveText(marker)
    await page.screenshot({path:testInfo.outputPath('activity-desktop.png')})
    await page.getByRole('button', { name: 'Open original event' }).click()
    await expect(page.getByTestId('search-input')).toBeHidden()
    await page.getByRole('button', { name: /Back to Search/ }).click()
    await expect(page.getByTestId('search-input')).toHaveValue(marker)
    await expect(page.locator('pre')).toContainText(marker)
    await page.setViewportSize({ width: 800, height: 700 })
    await expect(page.getByRole('searchbox', { name: 'Find in content' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({path:testInfo.outputPath('activity-narrow.png')})
    const aiMarker = 'AI-SAVED-RESULT-482'
    for (const data of [
      {subtype:'tool_call',agent:'claude-code',session_id:'activity-ai',tool_use_id:'tool-ai',tool_name:'Bash',tool_input:{command:'printf sample'}},
      {subtype:'tool_result',agent:'claude-code',session_id:'activity-ai',tool_use_id:'tool-ai',output:aiMarker}
    ]) {
      const saved = await fetch(`${base}/api/events/seed`, {
        method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify({agent_type:'agent',data})
      })
      expect(saved.ok).toBe(true)
    }
    await page.getByTestId('search-input').fill(aiMarker)
    await expect(page.getByTestId('activity-row')).toHaveCount(1)
    await expect(page.getByTestId('activity-row')).toContainText('1 matching · 1 context')
    await page.getByTestId('activity-row').click()
    await expect(page.getByLabel('Source event').locator('option:checked')).toContainText('Tool result')
    await expect(page.locator('pre')).toContainText(aiMarker)
    const shellMarker = 'SHELL-SAVED-RESULT-611'
    for (const data of [
      {subtype:'command_start',shell:'bash',terminalId:'shell-e2e',command_id:'command-e2e',command:'printf shell-e2e-input'},
      {subtype:'command_end',shell:'bash',terminalId:'shell-e2e',command_id:'command-e2e',command:'printf shell-e2e-input',exit_code:7,stdout:shellMarker,stderr:'synthetic stderr'}
    ]) {
      const saved = await fetch(`${base}/api/events/seed`, {
        method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify({agent_type:'shell',data})
      })
      expect(saved.ok).toBe(true)
    }
    await page.getByTestId('search-input').fill(shellMarker)
    await expect(page.getByTestId('activity-row')).toHaveCount(1)
    await expect(page.getByTestId('activity-row')).toContainText('1 matching · 1 context')
    await expect(page.getByTestId('activity-row')).toContainText('Command operation')
    await page.getByTestId('activity-row').click()
    await expect(page.locator('pre')).toContainText(shellMarker)
    await page.getByLabel('Content field').selectOption('stderr')
    await expect(page.locator('pre')).toHaveText('synthetic stderr')
    await page.getByTestId('search-input').fill('shell-e2e-input')
    await expect(page.getByTestId('activity-row')).toContainText('2 matching · 0 context')
    await page.getByTestId('activity-row').click()
    await expect(page.getByLabel('Source event').locator('option:checked')).toContainText('Command result')
    await expect(page.locator('pre')).toHaveText(shellMarker)


  } finally {
    await app.close()
  }
})
