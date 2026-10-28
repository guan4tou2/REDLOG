import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow, expectAppBuild } from './helpers'

test('Search opens indexed Activity output and returns from original evidence without losing the query', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    if (process.env.REDLOG_PACKAGED_APP) expect(await app.evaluate(({app})=>app.isPackaged)).toBe(true)
    const project=await openTestProject(page, 'http-body-search')
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
    await page.locator('#reading-tab-events').click()
    await page.getByTestId('search-input').fill(marker)
    await expect(page.getByRole('option').filter({hasText:'body-search.test'})).toBeVisible()
    await expect(page.getByText(/scanner:/)).toBeVisible()
    await expect(page.getByTestId('search-error')).toHaveCount(0)
    await page.getByRole('tab', { name: 'Operations', exact: true }).click()
    await expect(page.getByTestId('activity-row')).toHaveCount(1)
    await page.getByTestId('activity-row').click()
    await expect(page.getByLabel('Source event')).toBeVisible()
    await expect(page.getByRole('searchbox', { name: 'Find in content' })).toBeVisible()
    await expect(page.getByText('Saved source content does not apply web scope or sensitive-data redaction.', { exact: true })).toBeVisible()
    await page.getByRole('button',{name:'Copy saved content',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('Saved content exceeds 1 MiB')
    // Only the native destination picker is stubbed; the UI, content IPC,
    // version checks and byte-for-byte file delivery are real.
    const savedBody=join(tmpHome,'saved-body.txt')
    await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath})},savedBody)
    await page.getByRole('button',{name:'Save source content…',exact:true}).click()
    await expect.poll(()=>{try{return readFileSync(savedBody).length}catch{return 0}}).toBe(17*1024*1024+1+marker.length)
    expect(readFileSync(savedBody,'utf8')).toBe(`${'x'.repeat(17*1024*1024)} ${marker}`)
    await page.getByRole('searchbox', { name: 'Find in content' }).fill(marker)
    await page.getByRole('button', { name: 'Find in content', exact: true }).click()
    await expect(page.locator('pre:visible')).toContainText(marker)
    await expect(page.getByRole('button', { name: 'Previous window' })).toBeEnabled()
    await page.getByRole('button', { name: 'Previous window' }).click()
    await expect(page.locator('pre:visible')).not.toContainText(marker)
    await page.getByRole('button', { name: 'Next window' }).click()
    await expect(page.locator('pre:visible mark')).toHaveText(marker)
    await page.screenshot({path:testInfo.outputPath('activity-desktop.png')})
    await page.getByRole('button', { name: 'Open original event' }).click()
    await expect(page.getByTestId('search-input')).toBeHidden()
    await page.getByRole('button', { name: /Back to Activity/ }).click()
    await expect(page.getByTestId('search-input')).toHaveValue(marker)
    await expect(page.locator('pre:visible')).toContainText(marker)
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
    await expect(page.locator('pre:visible')).toContainText(aiMarker)
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
    await expect(page.locator('pre:visible')).toContainText(shellMarker)
    await page.getByLabel('Content field').selectOption('stderr')
    await expect(page.locator('pre:visible')).toHaveText('synthetic stderr')
    await page.getByTestId('search-input').fill('shell-e2e-input')
    await expect(page.getByTestId('activity-row')).toContainText('2 matching · 0 context')
    await page.getByTestId('activity-row').click()
    await expect(page.getByLabel('Source event').locator('option:checked')).toContainText('Command result')
    await expect(page.locator('pre:visible')).toHaveText(shellMarker)
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


    // The same workspace owns all reading modes and the query. Switching modes
    // must preserve a visited reader instead of reopening the application.
    await page.getByRole('tab', {name:'Input / output',exact:true}).click()
    await expect(page.locator('[data-block-id]')).toContainText(['shell-e2e-input'])
    const ioBlock = page.locator('[role="tabpanel"]:visible [data-block-id]').first()
    await expect(ioBlock.getByTestId('transcript-meta')).toContainText('exit 7')
    await page.getByRole('button',{name:'Saved content',exact:true}).first().click()
    await expect(page.getByRole('searchbox',{name:'Find in content'})).toBeVisible()
    for (const [width, height] of [[800, 700], [1600, 1000]]) {
      await resizeMainWindow(app, width, height)
      await expect(ioBlock.locator('pre').filter({ hasText: shellMarker })).toHaveCount(1)
      await expect(ioBlock.locator('pre').filter({ hasText: '$ printf shell-e2e-input' })).toBeVisible()
      await expect(ioBlock.getByTestId('transcript-meta')).toContainText('exit 7')
    }
    await ioBlock.getByRole('button', { name: 'Saved content', exact: true }).click()
    await expect(ioBlock.getByRole('searchbox', { name: 'Find in content' })).toHaveCount(0)
    await expect(ioBlock.locator('pre').filter({ hasText: shellMarker })).toHaveCount(1)
    await ioBlock.getByRole('button', { name: 'Saved content', exact: true }).click()
    await page.getByRole('searchbox',{name:'Find in content'}).fill('saved-reader-position')
    await page.getByRole('tab',{name:'Raw events',exact:true}).click()
    await expect(page.getByTestId('search-input')).toHaveValue('shell-e2e-input')
    await page.getByRole('tab',{name:'Input / output',exact:true}).click()
    await expect(page.getByRole('searchbox',{name:'Find in content'})).toHaveValue('saved-reader-position')
    await page.getByRole('button',{name:'Expand reader',exact:true}).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('searchbox',{name:'Find in content'})).toHaveValue('saved-reader-position')
    await page.keyboard.press(process.platform==='darwin'?'Meta+f':'Control+f')
    await expect(page.getByRole('dialog').getByRole('searchbox',{name:'Find in content'})).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('searchbox',{name:'Find in content'}).fill('')
    // Select visible source bytes through the reader, then save using the
    // ordinary marker form. The renderer does not submit an excerpt as proof.
    await page.locator('pre[tabindex="0"]:visible').evaluate(el=>{
      const range=document.createRange();range.selectNodeContents(el)
      const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range)
      el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))
    })
    await page.getByRole('button',{name:'Mark selection',exact:true}).click()
    await page.getByPlaceholder('What happened?').fill('Exact saved output fragment')
    await page.getByRole('button',{name:'Save marker',exact:true}).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(()=>page.getByLabel('Source session',{exact:true}).locator('option').count()).toBeGreaterThan(1)
    await page.getByLabel('Source session',{exact:true}).selectOption({index:1})
    await expect(page.locator('[role="tabpanel"]:visible [data-block-id]')).toHaveCount(1)
    await page.getByRole('tab',{name:'AI conversations',exact:true}).click()
    await page.getByTestId('search-input').fill(aiMarker)
    await expect(page.locator('[role="tabpanel"]:visible [data-block-id]')).toContainText([aiMarker])
    await page.getByLabel('AI source',{exact:true}).selectOption('claude-code')
    await expect.poll(()=>page.getByLabel('Source session',{exact:true}).locator('option').count()).toBe(2)
    await page.getByLabel('Source session',{exact:true}).selectOption({index:1})
    await page.getByTestId('search-input').fill('')
    await expect(page.locator('[role="tabpanel"]:visible [data-block-id]')).toContainText([aiMarker])
    const late='LATE-SESSION-MESSAGE-793'
    expect((await fetch(`${base}/api/events/seed`,{
      method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
      body:JSON.stringify({agent_type:'agent',data:{subtype:'assistant_message',agent:'claude-code',session_id:'activity-ai',full:late}})
    })).ok).toBe(true)
    await expect(page.getByRole('button',{name:'Refresh sessions',exact:true})).toBeVisible()
    await expect(page.locator('[role="tabpanel"]:visible')).not.toContainText(late)
    await page.getByRole('button',{name:'Refresh sessions',exact:true}).click()
    await expect(page.locator('[role="tabpanel"]:visible')).toContainText(late)
    await page.getByRole('button',{name:'Export',exact:true}).click()
    await expect(page.getByTestId('export-preview-subset')).toContainText('Entire source session')
    await page.getByLabel('Export format',{exact:true}).selectOption('other')
    await page.getByLabel('Other formats',{exact:true}).selectOption('json')
    await page.getByTestId('export-confirm').click()
    await expect(page.getByTestId('export-completed')).toBeVisible()
    const sessionArtifact=await page.evaluate(async()=>{const result=await window.redlog.data.recentExport();if(!result.ok||!result.delivery)throw new Error('missing export');return result.delivery.artifactPath})
    const sessionEvents=JSON.parse(readFileSync(sessionArtifact,'utf8')).events
    expect(sessionEvents).toHaveLength(3)
    expect(sessionEvents.every((e:any)=>e.data.agent==='claude-code'&&e.data.session_id==='activity-ai')).toBe(true)
    await page.getByRole('button',{name:'Close',exact:true}).last().click()
    await page.getByRole('tab',{name:'Raw events',exact:true}).click()
    await page.getByTestId('search-input').fill('Exact saved output fragment')
    await page.getByRole('option').filter({hasText:'Exact saved output fragment'}).click()
    await page.getByRole('button',{name:'Open source fragment',exact:true}).click()
    await expect(page.locator('pre:visible mark')).toHaveText(shellMarker)
    await page.getByRole('button',{name:/Back to Activity/}).click()
    // Root workspaces own their real secondary routes; no duplicate Sidebar
    // entries or query shortcuts masquerade as the removed primary pages.
    await expect(page.locator('nav').first().locator('[data-view-btn]')).toHaveCount(7)
    await openView(page,'bookmarks')
    await expect(page.getByRole('tab',{name:'Bookmarks',exact:true})).toHaveAttribute('aria-selected','true')
    await openView(page,'scope')
    await expect(page.getByRole('tab',{name:'Scope',exact:true})).toHaveAttribute('aria-selected','true')
    await openView(page,'search')
    await expect(page.getByTestId('search-input')).toHaveValue('Exact saved output fragment')
    await page.getByRole('tab',{name:'Operations',exact:true}).click()
    await page.getByTestId('search-input').fill('')
    await expect.poll(()=>page.getByTestId('activity-row').count()).toBeGreaterThanOrEqual(3)
    await page.screenshot({path:testInfo.outputPath('workspace-desktop.png')})
    const win=await app.browserWindow(page)
    await resizeMainWindow(app,800,600)
    await win.evaluate(w=>w.webContents.setZoomFactor(1.5))
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true)
    await expect(page.getByRole('tab',{name:'AI conversations',exact:true})).toBeInViewport()
    await expect.poll(()=>page.locator('nav').first().evaluate(el=>Math.round(parseFloat(getComputedStyle(el).width)))).toBe(48)
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const capture=await win.evaluate(async w=>(await w.capturePage()).toPNG().toString('base64'))
    writeFileSync(testInfo.outputPath('workspace-narrow-150.png'),Buffer.from(capture,'base64'))

    // The same app searches saved attachment bytes and confirmed AI raw bytes.
    // Only OS file pickers are substituted; copying, indexing and Reader IPC are real.
    await win.evaluate(w=>w.webContents.setZoomFactor(1))
    await resizeMainWindow(app,1200,900)
    const picked=join(tmpHome,'search-coverage.txt'),attachmentText='saved report ATTACHMENT-CONTENT-694'
    writeFileSync(picked,attachmentText)
    await app.evaluate(({dialog},filePath)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filePath]})},picked)
    await page.getByTestId('titlebar-add-file').click()
    await openView(page,'search')
    await page.getByRole('tab',{name:'Operations',exact:true}).click()
    await page.getByTestId('search-input').fill('ATTACHMENT-CONTENT-694')
    await expect(page.getByTestId('activity-row')).toHaveCount(1)
    await page.getByTestId('activity-row').click()
    await expect(page.locator('pre:visible')).toHaveText(attachmentText)
    const projectDir=join(tmpHome,'.redlog','projects',project.id)
    const rawDir=join(projectDir,'agent-transcripts');mkdirSync(rawDir,{recursive:true})
    const rawFile=join(rawDir,'coverage.jsonl'),rawText='{"saved":"RAW-CONTENT-695"}\n'
    writeFileSync(rawFile,rawText)
    expect((await fetch(`${base}/api/events/seed`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
      body:JSON.stringify({agent_type:'agent',data:{subtype:'transcript_snapshot',agent:'codex',session_id:'coverage',snapshot_path:rawFile,
        cumulative_bytes:Buffer.byteLength(rawText),cumulative_sha256:createHash('sha256').update(rawText).digest('hex')}})})).ok).toBe(true)
    appendFileSync(rawFile,'{"unsnapshotted":"UNCONFIRMED-CONTENT-696"}\n')
    const privacy=page.getByRole('button',{name:'Non-work hidden',exact:true})
    if(await privacy.count())await privacy.click()
    const chained=page.getByRole('button',{name:/Chained only/})
    if(await chained.getAttribute('aria-pressed')==='true')await chained.click()
    await page.getByTestId('search-input').fill('RAW-CONTENT-695')
    await expect(page.getByTestId('activity-row')).toHaveCount(1)
    await page.getByTestId('activity-row').click()
    await expect(page.locator('pre:visible')).toHaveText(rawText)
    await expect(page.getByText(/Saved AI source.*Pending source indexes/)).toBeVisible()
    await page.screenshot({path:testInfo.outputPath('search-saved-raw-coverage.png')})
    await page.locator('summary').filter({hasText:'Search coverage'}).click()
    await expect(page.getByText('Content search covers verified saved text, confirmed AI prefixes and complete recording frames. Binary content and unconfirmed tails are excluded; filters can further restrict coverage.',{exact:true})).toBeVisible()
    await resizeMainWindow(app,800,700)
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({path:testInfo.outputPath('search-saved-coverage-narrow.png')})
    await resizeMainWindow(app,1200,900)
    await page.getByTestId('search-input').fill('UNCONFIRMED-CONTENT-696')
    await expect(page.getByTestId('activity-row')).toHaveCount(0)
    await expect(page.getByText(/Saved AI source.*Pending source indexes/)).toBeVisible()

    const castsDir=join(projectDir,'casts');mkdirSync(castsDir,{recursive:true})
    const castFile=join(castsDir,'coverage.cast')
    const writeRecording=(text:string):void=>writeFileSync(castFile,[JSON.stringify({version:2,width:80,height:24,timestamp:1700000000}),JSON.stringify([0.1,'o',text+'\r\n'])].join('\n')+'\n')
    writeRecording('CAST-CONTENT-697')
    appendFileSync(castFile,'[1,"o","UNFINISHED-CAST-698')
    await page.getByTestId('search-input').fill('CAST-CONTENT-697')
    const castOutput=page.getByTitle('Show the surrounding output', {exact:true})
    await expect(castOutput).toHaveCount(1)
    await castOutput.click()
    await expect(page.locator('pre:visible')).toContainText('CAST-CONTENT-697')
    await expect(page.locator('pre:visible')).not.toContainText('UNFINISHED-CAST-698')
    await page.getByTestId('search-input').fill('UNFINISHED-CAST-698')
    await expect(castOutput).toHaveCount(0)
    writeRecording('CAST-REPLACED-699')
    await page.getByTestId('search-input').fill('CAST-REPLACED-699')
    await expect(castOutput).toHaveCount(1)
    await castOutput.click()
    await expect(page.locator('pre:visible')).toContainText('CAST-REPLACED-699')
    await page.screenshot({path:testInfo.outputPath('search-cast-coverage.png')})

  } catch(error) {
    console.log(`[search coverage] ${(error as Error).message}`)
    throw error
  } finally {
    await app.close()
  }
})
