import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { makeTempHome, openTestProject, openView } from './helpers'
import { findShellTarget, runZsh } from '../test/helpers/zsh-pty'

// Opt-in so ordinary source E2E never mistakes a stale package for this build.
test('POSIX package installs and records with the bundled session helper', async () => {
  test.skip(process.platform === 'win32' || !process.env.REDLOG_PACKAGED_APP, 'Requires an installed POSIX package and Zsh')
  test.setTimeout(90_000)
  const tmpHome = makeTempHome('redlog-package-session-')
  const app = await electron.launch({ executablePath: process.env.REDLOG_PACKAGED_APP!, args: [`--user-data-dir=${join(tmpHome, 'userdata')}`], env: {
    ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NODE_ENV: 'test', REDLOG_E2E: '1'
  } })
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'packaged-session-smoke')
    const rc = join(tmpHome, '.zshrc')
    const before = existsSync(rc) ? readFileSync(rc, 'utf8') : ''
    const installed = await page.evaluate(() => window.redlog.hooks.install('shell-zsh'))
    expect(installed).toMatchObject({ success: true })
    expect(await page.evaluate(() => window.redlog.hooks.install('shell-zsh'))).toMatchObject({ success: true })
    expect(readFileSync(rc, 'utf8').split(/\r?\n/).filter(line => /shell-hook\.zsh/.test(line))).toHaveLength(1)
    const helper = join(tmpHome, '.redlog', 'redlog-session.py')
    expect(existsSync(helper)).toBe(true)
    const child = spawn('/bin/zsh', ['-c', `source "$HOME/.redlog/shell-hook.zsh"
for n in 1 2 3 4 5; do
  redlog-session -- /bin/echo packaged-pty-canary-$n || exit $?
done`], {
      env: { ...process.env, HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let diagnostics = ''
    child.stderr.on('data', b => { diagnostics += b })
    let output = ''
    child.stdout.on('data', b => { output += b })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code, diagnostics).toBe(0)
    for (let n = 1; n <= 5; n++) expect(output, diagnostics).toContain(`packaged-pty-canary-${n}`)
    const recorded = await page.evaluate(async () => (await window.redlog.events.query({ limit: 1000 })).filter(e =>
      e.data.captured_by === 'redlog-session' && String(e.data.command ?? '').includes('packaged-pty-canary')))
    expect(recorded.filter(e => e.data.subtype === 'session_start')).toHaveLength(5)
    for (const start of recorded.filter(e => e.data.subtype === 'session_start')) {
      const boundary = await page.evaluate(async id => (await window.redlog.events.query({ limit: 1000 })).filter(e => e.data.terminalId === id), start.data.terminalId)
      expect(boundary.filter(e => e.data.subtype === 'session_output').map(e => e.data.stdout).join('')).toContain(String(start.data.command).split(' ').at(-1))
      expect(boundary.find(e => e.data.subtype === 'session_end')?.data).toMatchObject({ exitCode: 0, outputBytes: expect.any(Number), omittedBytes: 0 })
      expect(boundary.find(e => e.data.subtype === 'session_end')?.data.outputBytes).toBeGreaterThan(0)
    }
    await openView(page, 'search')
    await page.locator('#reading-tab-events').click()
    await page.getByTestId('search-input').fill('packaged-pty-canary')
    // Hidden visited readers keep the same title mounted; match the raw event row.
    for (let n = 1; n <= 5; n++) {
      await expect(page.getByRole('option').filter({ hasText: new RegExp(`PTY #1: packaged-pty-canary-${n}(?!\\d)`) })).toBeVisible()
    }
    // Read the exact profile the installer wrote and let a new interactive
    // Zsh source it. This proves ordinary commands, not only an explicit helper.
    const shell = findShellTarget()
    expect(shell, 'the host must have a real Zsh for this POSIX test').toBeTruthy()
    const session = await runZsh(shell!, {
      rc: readFileSync(rc, 'utf8'),
      env: { _REDLOG_DIR: join(tmpHome, '.redlog'), REDLOG_TERMINAL: '', REDLOG_EXTERNAL_SESSION: '' },
      commands: ['echo packaged-auto-canary', "sh -c 'exit 3'"],
      timeoutSeconds: 30
    })
    expect(session.ok, session.error).toBe(true)
    expect(session.steps[0].output).toContain('packaged-auto-canary')
    await expect.poll(() => page.evaluate(async () => {
      const rows = await window.redlog.events.query({ limit: 1000 })
      return rows.find(e => e.data.subtype === 'command_end' && e.data.command === 'echo packaged-auto-canary')?.data
    }), { timeout: 15_000 }).toMatchObject({ source: 'auto-relay', shell: 'zsh', exit_code: 0, stdout: expect.stringContaining('packaged-auto-canary') })
    await expect.poll(() => page.evaluate(async () => {
      const rows = await window.redlog.events.query({ limit: 1000 })
      return rows.find(e => e.data.subtype === 'command_end' && e.data.command === "sh -c 'exit 3'")?.data.exit_code
    }), { timeout: 15_000 }).toBe(3)
    expect(await page.evaluate(() => window.redlog.hooks.uninstall('shell-zsh'))).toMatchObject({ success: true })
    expect(existsSync(rc) ? readFileSync(rc, 'utf8') : '').toBe(before)
  } catch (error) {
    console.error('Packaged session smoke failed:', error)
    throw error
  } finally {
    await app.close()
  }
})
