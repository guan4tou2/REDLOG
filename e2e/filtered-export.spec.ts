import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView } from './helpers'

for (const locale of ['en', 'zh-TW']) {
 test(`filtered export is explicit, frozen and readable in ${locale}`, async () => {
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
   await page.evaluate(l => localStorage.setItem('redlog-locale',l), locale)
   await openTestProject(page,'filtered-export')
   const base=`http://127.0.0.1:${readFileSync(join(tmpHome,'.redlog','api-port'),'utf8').trim()}`
   const token=readFileSync(join(tmpHome,'.redlog','api-token'),'utf8').trim()
   const matching = ['needle evidence', ...Array.from({ length: 105 }, (_, i) => `needle paginated ${i}`)]
   for (const command of [...matching, 'other evidence']) {
    const result=await fetch(base+'/api/events/seed',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({agent_type:'shell',target_id:'example.test',data:{subtype:'command_end',command,exit_code:0}})})
    expect(result.ok).toBe(true)
   }
   await openView(page,'search')
   await page.getByTestId('search-input').fill('needle')
   await expect(page.getByText('needle paginated 104',{exact:false}).first()).toBeVisible()
   const win=await app.browserWindow(page); await win.evaluate(w=>w.setSize(800,850))
   const exportLabel=locale==='en'?'Export':'匯出'
   await page.getByLabel(exportLabel,{exact:true}).click()
   await expect(page.getByTestId('export-preview-subset')).toContainText('needle')
   // Search has a 100-row page. Export must include all 106 matches without
   // requiring Load more, and switching format must retain that query.
   const formatLabel=locale==='en'?'Export format':'匯出格式'
   await page.getByLabel(formatLabel,{exact:true}).selectOption('ndjson')
   await expect(page.getByTestId('export-preview-subset')).toContainText('needle')
   await page.getByLabel(formatLabel,{exact:true}).selectOption('json')
   await expect(page.getByTestId('export-projection-notice')).toBeVisible()
   await expect(page.getByTestId('export-confirm')).toBeEnabled()
   // A matching event received after the operator saw the preview must not
   // enter the confirmed artifact, even though it appears in the live search.
   const later=await fetch(base+'/api/events/seed',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({agent_type:'shell',target_id:'example.test',data:{subtype:'command_end',command:'needle after preview',exit_code:0}})})
   expect(later.ok).toBe(true)
   const dialog=page.getByTestId('export-dialog')
   expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
   await page.getByTestId('export-confirm').focus(); await page.keyboard.press('Enter')
   await expect(dialog).toHaveCount(0)
   const active=await page.evaluate(async () => {
    const current=await window.redlog.project.active()
    return (await window.redlog.project.list()).find(project => project.id===current?.id)!
   })
   const exportDir=join(active.path,'exports')
   const artifact=readdirSync(exportDir).find(name => name.endsWith('.json') && !name.endsWith('.manifest.json'))!
   const rows=JSON.parse(readFileSync(join(exportDir,artifact),'utf8')).events
   expect(rows.map((row: { data: { command: string } })=>row.data.command).sort()).toEqual([...matching].sort())
   // A legitimate empty selection still previews; it cannot be confirmed.
   await page.getByTestId('search-input').fill('never-recorded-token')
   await page.getByLabel(exportLabel,{exact:true}).click()
   await expect(page.getByTestId('export-confirm')).toBeDisabled()
   await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
   await page.getByTestId('search-input').fill('session:')
   await page.getByLabel(exportLabel,{exact:true}).click()
   await expect(page.getByText('Invalid export query',{exact:false})).toBeVisible()
  } finally { await app.close() }
 })
}
