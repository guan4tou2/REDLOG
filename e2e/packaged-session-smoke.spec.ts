import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { makeTempHome, openTestProject, openView } from './helpers'

// Opt-in so ordinary source E2E never mistakes a stale package for this build.
test('macOS package installs and records with the bundled session helper', async () => {
  test.skip(process.platform !== 'darwin' || !process.env.REDLOG_PACKAGED_APP, 'Requires a freshly built macOS app')
  test.setTimeout(90_000)
  const tmpHome = makeTempHome('redlog-package-session-')
  const app = await electron.launch({ executablePath: process.env.REDLOG_PACKAGED_APP!, env: {
    ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NODE_ENV: 'test', REDLOG_E2E: '1'
  } })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'packaged-session-smoke')
    const installed = await page.evaluate(() => window.redlog.hooks.install('shell-zsh'))
    expect(installed).toMatchObject({ success: true })
    const helper = join(tmpHome, '.redlog', 'redlog-session.py')
    expect(existsSync(helper)).toBe(true)
    const child = spawn('/bin/zsh', ['-c', `source "$HOME/.redlog/shell-hook.zsh"; redlog-session -- /bin/echo packaged-pty-canary`], {
      env: { ...process.env, HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let diagnostics = ''
    child.stderr.on('data', b => { diagnostics += b })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code, diagnostics).toBe(0)
    await openView(page, 'search')
    await page.getByTestId('search-input').fill('packaged-pty-canary')
    await expect(page.getByText(/PTY #1: packaged-pty-canary/)).toBeVisible()
  } finally {
    await app.close()
  }
})
