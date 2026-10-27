import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow, expectAppBuild } from './helpers'

test('Search opens indexed Activity output and returns from original evidence without losing the query', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    if (process.env.REDLOG_PACKAGED_APP) expect(await app.evaluate(({app})=>app.isPackaged)).toBe(true)
    await openTestProject(page, 'http-body-search')
    if (process.env.REDLOG_EXPECTED_BUILD) {
      await expectAppBuild(app,page,process.env.REDLOG_EXPECTED_BUILD)
      await page.screenshot({path:testInfo.outputPath('installed-build-id.png')})
    }

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
          response_body: { data: `${'x'.repeat(17 * 1024 * 1024)} ${marker}`, encoding: 'text', size: 5024, sha256: 'producer-value' }
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
    // Resize the native window, not Chromium's emulated viewport. Emulation
    // leaves the renderer occupying only part of a larger Electron surface.
    for(const [name,width,height] of [['narrow',800,700],['wide',1600,1000]] as const) {
      await resizeMainWindow(app,width,height)
      const native=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('overlay'))!.getContentSize())
      await expect.poll(()=>page.evaluate(()=>[innerWidth,innerHeight])).toEqual(native)
      await expect(page.getByRole('searchbox',{name:'Find in content'})).toBeVisible()
      await expect.poll(()=>page.evaluate(()=>{
        const root=document.getElementById('root')!.getBoundingClientRect()
        const status=document.querySelector('[data-testid="status-bar"]')!.getBoundingClientRect()
        return Math.abs(root.right-innerWidth)<=2 && Math.abs(root.bottom-innerHeight)<=2
          && Math.abs(status.right-innerWidth)<=2 && Math.abs(status.bottom-innerHeight)<=2
          && document.documentElement.scrollWidth<=document.documentElement.clientWidth
      })).toBe(true)
      await page.screenshot({path:testInfo.outputPath(`activity-${name}.png`)})
    }
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
    // The same running app proves both explicit scopes, including members
    // that did not match the search text. No separate launch per assertion.
    for (const kind of ['activity','session'] as const) {
      await page.getByLabel('Selection',{exact:true}).selectOption(kind)
      await page.getByRole('button',{name:'Export',exact:true}).click()
      await expect(page.getByTestId('export-preview-subset')).toContainText(kind==='activity' ? 'Selected operation' : 'Entire source session')
      await page.getByLabel('Export format',{exact:true}).selectOption('other')
      await page.getByLabel('Other formats',{exact:true}).selectOption('json')
      await page.getByTestId('export-confirm').click()
      await expect(page.getByTestId('export-completed')).toBeVisible()
      const delivery=await page.evaluate(async()=>{
        const result=await window.redlog.data.recentExport()
        if(!result.ok || !result.delivery) throw new Error('missing delivery')
        return result.delivery
      })
      const evidence=JSON.parse(readFileSync(delivery.artifactPath,'utf8'))
      expect(evidence.events).toHaveLength(2)
      expect(evidence.events.some((e:any)=>e.data.stdout===shellMarker)).toBe(true)
      expect(evidence.events.some((e:any)=>e.data.subtype==='command_start')).toBe(true)
      await page.getByRole('button',{name:'Close',exact:true}).last().click()
    }



  } finally {
    await app.close()
  }
})
