import { test, expect, type Page } from '@playwright/test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject } from './helpers'

// The capture browser's profile lives in the project that launched it, so its
// cookies and sign-ins are that engagement's. Left running across a switch, it
// sent the next project HTTP through the restarted proxy while its navigations
// went unrecorded. It now closes with the project that launched it.

type BrowserBridge = {
  config: { get: () => Promise<Record<string, unknown>>; save: (c: unknown) => Promise<unknown> }
  browser: {
    launch: () => Promise<{ ok: boolean; pid?: number; error?: string }>
    status: () => Promise<{ running: boolean }>
  }
}

const browserRunning = (page: Page): Promise<boolean> =>
  page.evaluate(async () => (await (window as unknown as { redlog: BrowserBridge }).redlog.browser.status()).running)

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

test.skip(process.platform === 'win32', 'the stand-in browser is a #!/bin/sh script')

test('the capture browser closes with the project that launched it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'redlog-stand-in-browser-'))
  // exec, so the stand-in is one process that dies when it is told to.
  const binary = join(dir, 'chromium')
  writeFileSync(binary, '#!/bin/sh\nexec sleep 600\n')
  chmodSync(binary, 0o755)
  const { app, page } = await launchWithTempHome()
  try {
    await openTestProject(page, 'browser-owner')
    const launched = await page.evaluate(async (bin) => {
      const r = (window as unknown as { redlog: BrowserBridge }).redlog
      const cfg = await r.config.get()
      // No proxy: this checks the browser's lifetime, not HTTP capture.
      await r.config.save({ ...cfg, browser: { ...(cfg.browser as object ?? {}), binary: bin, proxy: '' } })
      return r.browser.launch()
    }, binary)
    expect(launched, launched.error).toMatchObject({ ok: true })
    expect(await browserRunning(page)).toBe(true)
    expect(alive(launched.pid!)).toBe(true)

    await openTestProject(page, 'browser-next')

    await expect.poll(() => browserRunning(page)).toBe(false)
    await expect.poll(() => alive(launched.pid!)).toBe(false)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
