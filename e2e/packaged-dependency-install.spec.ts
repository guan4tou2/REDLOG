import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeTempHome, openTestProject } from './helpers'

// Opt-in: downloads public mitmproxy packages into this test's private uv
// directories. It does not touch installed user tools or the system trust store.
test('packaged setup installs missing HTTP tools and reaches real capture', async () => {
  test.skip(process.platform !== 'darwin' || !process.env.REDLOG_PACKAGED_APP || process.env.REDLOG_PACKAGED_INSTALL_DEPS !== '1', 'Requires a current macOS package and explicit dependency-install opt-in')
  test.setTimeout(240_000)
  const uv = spawnSync('which', ['uv'], { encoding: 'utf8' }).stdout.trim()
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
  expect(existsSync(uv)).toBe(true)
  expect(existsSync(python)).toBe(true)
  const home = makeTempHome('redlog-package-install-')
  const bin = join(home, 'bin')
  mkdirSync(bin)
  symlinkSync(uv, join(bin, 'uv'))
  symlinkSync(python, join(bin, 'python3'))
  const app = await electron.launch({ executablePath: process.env.REDLOG_PACKAGED_APP!, env: {
    ...process.env, HOME: home, USERPROFILE: home, REDLOG_E2E: '1', NODE_ENV: 'test',
    UV_TOOL_DIR: join(home, 'uv-tools'), UV_TOOL_BIN_DIR: bin,
    UV_CACHE_DIR: join(home, 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(home, 'uv-python')
  } })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    // Let login-PATH resolution finish, then constrain only this app process's
    // PATH. Existing host mitmdump must not satisfy the missing-tool condition.
    await page.evaluate(() => window.redlog.runtime.preflight())
    await app.evaluate((_electron, bin) => { process.env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }, bin)
    await openTestProject(page, 'real-dependency-install')
    expect((await page.evaluate(() => window.redlog.runtime.preflight())).checks.find(c => c.id === 'mitmdump')?.found).toBe(false)
    await expect(page.getByTestId('prepare-dependency-mitmdump')).toBeVisible()
    await page.getByTestId('prepare-install-mitmdump').click()
    await expect(page.getByTestId('capture-prepare')).toHaveCount(0, { timeout: 180_000 })
    expect(existsSync(join(bin, 'mitmdump'))).toBe(true)
    expect((await page.evaluate(() => window.redlog.runtime.preflight())).checks.find(c => c.id === 'mitmdump')?.found).toBe(true)
    await expect(page.getByTestId('first-run-http-status')).toHaveText('○ Not verified')
    await page.getByTestId('first-run-http-restart').click()
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()), { timeout: 30_000 }).toMatchObject({ state: 'running' })
    const card = page.getByTestId('first-run-http')
    await expect(page.getByTestId('first-run-http-checks')).toBeVisible()
    const nonce = await card.getAttribute('data-nonce')
    const status = await page.evaluate(() => window.redlog.httpCapture.status())
    const curl = spawnSync('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--max-time', '10', '--noproxy', '', '--proxy', status.url!, `http://redlog.verify.invalid/${nonce}`], { encoding: 'utf8' })
    expect(curl.status, curl.stderr).toBe(0)
    await expect(page.getByTestId('first-run-http-check-http')).toHaveAttribute('data-verified', 'true')
    await expect(page.getByTestId('first-run-http-check-https')).toHaveAttribute('data-verified', 'false')
    await page.screenshot({ path: join(home, 'installed-http-tools.png') })
    console.log('Isolated dependency install evidence:', home)
  } catch (error) {
    console.error('Packaged dependency install failed:', error)
    throw error
  } finally {
    await app.close()
  }
})
