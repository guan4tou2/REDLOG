import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchWithTempHome, openCaptureProof, requireMitmdump } from './helpers'

// The other three journeys that lived in this file now share an Electron launch:
// HTTP scope and violation details in evidence-views.spec.ts, terminal font
// shortcuts in app-shell.spec.ts. This one stays alone because it restarts the
// app inside the test.
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
