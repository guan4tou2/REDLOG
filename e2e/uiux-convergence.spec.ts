import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchWithTempHome, openView, openCaptureProof, requireMitmdump, resizeMainWindow } from './helpers'

test('real HTTPS evidence persists as history without restoring live proof after restart or crossing projects', async () => {
  test.skip(process.platform === 'win32', 'This native acceptance uses the installed POSIX curl/mitmdump')
  requireMitmdump()
  test.setTimeout(120_000)
  let { app, page, tmpHome } = await launchWithTempHome()
  try {
    const a = await page.evaluate(() => window.redlog.project.create('http-history-proof', { network: { offline: true } }))
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openCaptureProof(page)
    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(async () => (await page.evaluate(() => window.redlog.httpCapture.status())).certReady, { timeout: 35_000 }).toBe(true)
    const nonce = await page.getByTestId('first-run-http').getAttribute('data-nonce')
    const status = await page.evaluate(() => window.redlog.httpCapture.status())
    const request = spawnSync('curl', ['--noproxy', '', '--max-time', '15', '--cacert', status.caPath!, '--proxy', status.url!, `https://redlog.verify.invalid/${nonce}`], { encoding: 'utf8', timeout: 20_000 })
    expect(request.status, request.stderr).toBe(0)
    await expect.poll(async () => (await page.evaluate(() => window.redlog.httpCapture.status())).verificationEvidence?.projectId).toBe(a.id)
    const proven = await page.evaluate(() => window.redlog.httpCapture.status())
    expect(proven.httpsVerification?.scheme).toBe('https')
    expect(proven.verificationEvidence?.clientIdentity).toBeNull()
    expect(proven.verificationEvidence?.caTrustVerified).toBe(false)
    const bytes = readFileSync(join(tmpHome, '.redlog', 'projects', a.id, 'http-verification.json'), 'utf8')
    expect(bytes).not.toContain(nonce!)
    await app.close()
    ;({ app, page } = await launchWithTempHome(undefined, { home: tmpHome }))
    await page.evaluate(id => window.redlog.project.open(id), a.id)
    await page.reload()
    await page.evaluate(() => window.redlog.httpCapture.start())
    const restarted = await page.evaluate(() => window.redlog.httpCapture.status())
    expect(restarted.sourceInstance).not.toBe(proven.sourceInstance)
    expect(restarted.httpsVerification).toBeUndefined()
    expect(restarted.verificationState).toBe('previously-verified')
    expect(restarted.verificationEvidence?.verifiedAt).toBe(proven.verificationEvidence?.verifiedAt)
    const b = await page.evaluate(() => window.redlog.project.create('no-inherited-proof', { network: { offline: true } }))
    expect(b.id).not.toBe(a.id)
    expect((await page.evaluate(() => window.redlog.httpCapture.status())).verificationEvidence).toBeNull()
    await page.evaluate(id => window.redlog.project.open(id), a.id)
    await page.evaluate(async () => { const config = await window.redlog.config.get(); await window.redlog.config.save({ ...config!, httpCapture: { ...config!.httpCapture!, routeTerminals: true } }) })
    expect((await page.evaluate(() => window.redlog.httpCapture.status())).verificationState).toBe('invalidated')
  } catch (error) { console.log(`[HTTP evidence] ${String(error)}`); throw error }
  finally { await app.close() }
})

test('HTTP scope distinguishes unset, outside and unreadable policy at desktop and minimum window', async () => {
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => window.redlog.project.create('http-scope-display', { network: { offline: true } }))
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const response = await fetch(`${base}/api/events/seed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ agent_type: 'scanner', data: { subtype: 'http_request_start', flow_id: 'scope-proof', url: 'https://outside.test/path', host: 'outside.test', method: 'GET' } }) })
    expect(response.ok).toBe(true)
    await openView(page, 'http_history')
    await expect(page.getByTestId('http-scope-state')).toHaveAttribute('data-scope', 'no-scope')
    await page.evaluate(async () => { const c = await window.redlog.config.get(); await window.redlog.config.save({ ...c!, scope: { ...c!.scope, targets: ['inside.test'] } }) })
    await expect(page.getByTestId('http-scope-state')).toHaveAttribute('data-scope', 'out-of-scope')
    await resizeMainWindow(app, 800, 500)
    await expect(page.getByTestId('http-scope-state')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('http-scope-minimum.png') })
    await page.evaluate(async () => { const c = await window.redlog.config.get(); await window.redlog.config.save({ ...c!, scope: { ...c!.scope, scopeFile: '/missing-scope-fixture.txt' } }) })
    await expect(page.getByTestId('http-scope-state')).toHaveAttribute('data-scope', 'unknown')
  } finally { await app.close() }
})

test('terminal font shortcuts keep search input and Electron zoom independent', async () => {
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => window.redlog.project.create('terminal-font-focus', { network: { offline: true } }))
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openView(page, 'terminal')
    const terminal = page.locator('.xterm-helper-textarea').first()
    await expect(terminal).toBeAttached()
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const window = await app.browserWindow(page)
    const zoom = await window.evaluate(w => w.webContents.getZoomFactor())
    await page.evaluate(() => localStorage.setItem('redlog-terminal-fontsize', '13'))
    await terminal.focus()
    await page.keyboard.press(`${mod}+=`)
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('redlog-terminal-fontsize')))).toBe(14)
    await page.getByRole('button', { name: 'Search buffer', exact: true }).click()
    await page.getByPlaceholder('Search terminal buffer… Enter = next, Shift+Enter = previous', { exact: true }).focus()
    await page.keyboard.press(`${mod}+-`)
    expect(await page.evaluate(() => Number(localStorage.getItem('redlog-terminal-fontsize')))).toBe(14)
    expect(await window.evaluate(w => w.webContents.getZoomFactor())).toBe(zoom)
    await terminal.focus()
    await page.keyboard.press(`${mod}+0`)
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('redlog-terminal-fontsize')))).toBe(13)
  } finally { await app.close() }
})

test('violation details resolve the full command and carry an uncommitted candidate to Scope settings', async () => {
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => window.redlog.project.create('scope-detail-candidate', { network: { offline: true }, scope: { targets: ['inside.test'], excludeTargets: ['outside.test'], warnOnViolation: true } }))
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const command = 'curl https://outside.test/' + 'original-argument-'.repeat(30)
    const posted = await fetch(`${base}/api/events/seed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', detectedTarget: 'outside.test', command } }) })
    expect(posted.ok).toBe(true)
    await openView(page, 'scope')
    await page.getByTestId('scope-judged-live').first().click()
    const detail = page.getByTestId('scope-violation-detail')
    await expect(detail.locator('pre')).toHaveText(command)
    await expect(detail).toContainText('Matched exclusion rule · outside.test')
    await detail.getByRole('button', { name: 'Edit related scope rules' }).click()
    await expect(page.getByRole('textbox', { name: 'Targets (IPs, CIDRs, *.domain)', exact: true })).toHaveValue('outside.test')
    const saved = await page.evaluate(() => window.redlog.config.get())
    expect(saved?.scope.targets).toEqual(['inside.test'])
    await page.screenshot({ path: test.info().outputPath('scope-candidate-uncommitted.png') })
  } finally { await app.close() }
})
