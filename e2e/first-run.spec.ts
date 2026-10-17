import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView, openCaptureProof, resizeMainWindow } from './helpers'

// Capture preparation/proof, skipping and recovery through the real app.
// Reopening setup preserves evidence and terminal sessions; recorded projects
// still have a fixed entry. REDLOG_PACKAGED_APP selects the installed build.

let app: ElectronApplication
let page: Page
let tmpHome: string

const post = async (agent_type: string, data: Record<string, unknown>): Promise<void> => {
  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  await fetch(`${base}/api/events/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_type, data })
  })
}

test('skipping setup before any action keeps recovery and unverified states across a reload', async () => {
  const home = makeTempHome('redlog-skip-setup-')
  const skippedApp = await electron.launch({
    ...(process.env.REDLOG_PACKAGED_APP ? { executablePath: process.env.REDLOG_PACKAGED_APP } : {}),
      args: process.env.REDLOG_PACKAGED_APP ? [] : [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: home, USERPROFILE: home, REDLOG_E2E: '1' }
  })
  try {
    const skippedPage = await skippedApp.firstWindow()
    await skippedPage.waitForLoadState('domcontentloaded')
    await skippedPage.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(skippedPage, 'skipped-setup')
    await resizeMainWindow(skippedApp, 800, 720)
    await openCaptureProof(skippedPage)
    await expect(skippedPage.getByTestId('first-run-commands-status')).toHaveText('○ Not verified')
    await expect(skippedPage.getByTestId('first-run-http-status')).toHaveText('○ Not verified')
    const config = await skippedPage.evaluate(() => window.redlog.config.get())
    await skippedPage.getByTestId('first-run-later').click()
    await openView(skippedPage, 'dashboard')
    await expect(skippedPage.getByRole('heading', { name: 'Get this engagement fully recorded' })).toBeVisible()
    await skippedPage.reload()
    await openView(skippedPage, 'dashboard')
    await openCaptureProof(skippedPage)
    await expect(skippedPage.getByRole('heading', { name: 'Get this engagement fully recorded' })).toBeVisible()
    await expect(skippedPage.getByTestId('first-run-strip')).toHaveAttribute('data-core-ready', 'false')
    await expect(skippedPage.getByTestId('first-run-commands-status')).toHaveText('○ Not verified')
    await expect(skippedPage.getByTestId('first-run-http-status')).toHaveText('○ Not verified')
    const after = await skippedPage.evaluate(() => window.redlog.config.get())
    expect(after.engagement).toEqual(config.engagement)
    expect(after.scope).toEqual(config.scope)
  } finally {
    await skippedApp.close()
  }
})

test('a dependency install failure stays beside the retry and manual command', async () => {
  const home = makeTempHome('redlog-install-recovery-')
  const recoveryApp = await electron.launch({
    ...(process.env.REDLOG_PACKAGED_APP ? { executablePath: process.env.REDLOG_PACKAGED_APP } : {}),
      args: process.env.REDLOG_PACKAGED_APP ? [] : [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: home, USERPROFILE: home, REDLOG_E2E: '1' }
  })
  try {
    // Controlled IPC outcomes exercise the real renderer workflow; this is
    // not a claim that a clean host downloaded or installed a dependency.
    await recoveryApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('runtime:preflight')
      ipcMain.handle('runtime:preflight', () => ({
        platform: 'darwin', shell: { name: 'zsh', hookId: 'shell-zsh' },
        checks: [
          { id: 'python3', found: true, neededFor: [] },
          { id: 'curl', found: true, neededFor: [] },
          { id: 'zsh', found: true, neededFor: [] },
          { id: 'mitmdump', found: false, neededFor: ['mitmproxy'], remediation: 'uv tool install mitmproxy' }
        ]
      }))
      ipcMain.removeHandler('runtime:install')
      ipcMain.handle('runtime:install', () => ({ success: false, message: 'Network unavailable: isolated test failure' }))
    })
    const recoveryPage = await recoveryApp.firstWindow()
    await recoveryPage.waitForLoadState('domcontentloaded')
    await recoveryPage.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(recoveryPage, 'installer-recovery')
    await resizeMainWindow(recoveryApp, 800, 720)
    await recoveryPage.getByTestId('first-run-http-prepare').click()
    const install = recoveryPage.getByTestId('prepare-install-mitmdump')
    await install.click()
    const error = recoveryPage.getByTestId('prepare-error-mitmdump')
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(error).toContainText('Network unavailable')
    await expect(error.locator('code')).toHaveText('uv tool install mitmproxy')
    expect(await error.locator('code').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(install).toBeEnabled()
    await expect(recoveryPage.getByTestId('first-run-http-status')).toHaveCount(0)
    await install.click()
    await expect(error).toBeVisible()
    await expect(recoveryPage.getByTestId('first-run-later')).toBeVisible()
    await recoveryPage.screenshot({ path: join(REPO_ROOT, 'test-results', 'capture-install-recovery.png') })
    // A successful installer is followed by an observed PATH check, then the
    // two independent proof cards. Installation itself verifies neither.
    await recoveryApp.evaluate(({ ipcMain }) => {
      let installed = false
      ipcMain.removeHandler('runtime:install')
      ipcMain.handle('runtime:install', () => { installed = true; return { success: true, message: 'isolated success' } })
      ipcMain.removeHandler('runtime:preflight')
      ipcMain.handle('runtime:preflight', () => ({ platform: 'darwin', shell: { name: 'zsh', hookId: 'shell-zsh' }, checks: [
        { id: 'python3', found: true, neededFor: [] }, { id: 'curl', found: true, neededFor: [] },
        { id: 'zsh', found: true, neededFor: [] }, { id: 'mitmdump', found: installed, neededFor: ['mitmproxy'] }
      ] }))
    })
    await install.click()
    await expect(recoveryPage.getByTestId('capture-prepare')).toHaveCount(0)
    await expect(recoveryPage.getByTestId('first-run-commands-status')).toHaveText('○ Not verified')
    await expect(recoveryPage.getByTestId('first-run-http-status')).toHaveText('○ Not verified')
    await recoveryPage.screenshot({ path: join(REPO_ROOT, 'test-results', 'capture-prepare-to-prove.png') })
  } catch (error) {
    console.error('Capture setup recovery failed:', error)
    throw error
  } finally {
    await recoveryApp.close()
  }
})

test.describe.serial('the first run', () => {
  test.beforeAll(async () => {
    tmpHome = makeTempHome('redlog-firstrun-')
    app = await electron.launch({
      ...(process.env.REDLOG_PACKAGED_APP ? { executablePath: process.env.REDLOG_PACKAGED_APP } : {}),
      args: process.env.REDLOG_PACKAGED_APP ? [] : [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'first-run')
    if (process.env.REDLOG_PACKAGED_APP) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await openCaptureProof(page)
    await page.waitForTimeout(2000)
    await resizeMainWindow(app, 1500, 1000)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('opens on the single-path screen, unlit', async () => {
    // The rows the app writes about itself on project open — a session start,
    // an IP verdict — must not count as the operator having done something.
    const strip = page.locator('[data-testid="first-run-strip"]')
    await expect(strip).toBeVisible()
    await expect(strip).toHaveAttribute('data-first-run-lit', 'false')
  })

  test('shows both core captures from the start, neither waiting on the other (#217)', async () => {
    await expect(page.locator('[data-testid="first-run-commands"]')).toBeVisible()
    await expect(page.locator('[data-testid="first-run-http"]')).toBeVisible()
    await expect(page.locator('[data-testid="first-run-commands-status"]')).toHaveText('○ Not verified')
    await expect(page.locator('[data-testid="first-run-http-status"]')).toHaveText('○ Not verified')
    await expect(page.locator('[data-testid="first-run-strip"]')).toHaveAttribute('data-core-ready', 'false')
  })

  test('external setup is primary and the built-in terminal is an explicit fallback', async () => {
    await expect(page.getByTestId('first-run-record-terminal')).toBeVisible()
    await expect(page.locator('.xterm')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list()).length)).toBe(0)
    await resizeMainWindow(app, 800, 600)
    const toggle = page.getByTestId('first-run-builtin-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list()).length)).toBe(1)
    await toggle.click()
    await expect(page.locator('.xterm')).toHaveCount(0)
    await resizeMainWindow(app, 1280, 800)
  })

  test('keeps the other capture sources one disclosure away', async () => {
    // The disclosure opens the capture card, which names the two core
    // captures and keeps everything else behind "all sources". It used to
    // assert the shell hook's capability line from the onboarding checklist;
    // that checklist is gone — it described the same two capabilities a second
    // time, in a third vocabulary — so the assertion is now the card itself.
    await expect(page.locator('[data-testid="first-run-more-sources"]')).toBeVisible()
    await page.click('[data-testid="first-run-more-sources"]')
    const core = page.locator('[data-testid="capture-core"]')
    await expect(core).toBeVisible()
    await expect(core.locator('[data-testid="capture-core-commands"]')).toBeVisible()
    await expect(core.locator('[data-testid="capture-core-http"]')).toBeVisible()
    await expect(page.getByRole('button', { name: /all sources/ })).toBeVisible()
    await page.click('[data-testid="first-run-more-sources"]')
  })

  test('installs the selected shell adapter with its shared runtime', async () => {
    await page.click('[data-testid="first-run-more-sources"]')
    await page.getByRole('button', { name: /all sources/ }).click()
    await page.getByRole('button', { name: 'install', exact: true }).first().click()
    // Which adapter "the first available source" is depends on the platform,
    // and so does what it installs. The POSIX adapters are `available: false`
    // on Windows — they need python3 and curl — so the first install there is
    // PowerShell, which copies its own hook and no POSIX shared runtime.
    // Asserting shell-common.sh unconditionally made this a POSIX-only test
    // that simply failed on a Windows runner.
    if (process.platform === 'win32') {
      await expect.poll(() => existsSync(join(tmpHome, '.redlog', 'shell-hook.ps1'))).toBe(true)
    } else {
      await expect.poll(() => existsSync(join(tmpHome, '.redlog', 'shell-common.sh'))).toBe(true)
      const adapterInstalled = existsSync(join(tmpHome, '.redlog', 'shell-hook.zsh')) ||
        existsSync(join(tmpHome, '.redlog', 'shell-bash-hook.sh'))
      expect(adapterInstalled).toBe(true)
    }
    await page.click('[data-testid="first-run-more-sources"]')
  })

  test('lights up on the first captured row', async () => {
    await post('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5' })
    await expect(page.locator('[data-testid="first-run-strip"]'))
      .toHaveAttribute('data-first-run-lit', 'true', { timeout: 15_000 })
    await expect(page.locator('[data-testid="first-run-commands-status"]')).toHaveText('✓ Verified')
    // A command does not make HTTP(S) any less unverified.
    await expect(page.locator('[data-testid="first-run-http-status"]')).toHaveText('○ Not verified')
    await expect(page.locator('[data-testid="first-run-later"]')).toBeVisible()
  })

  test('retains command proof after newer markers displace it from the recent display', async () => {
    for (let n = 0; n < 25; n++) await post('marker', { subtype: 'marker', text: `proof-window-fixture-${n}` })
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ limit: 20, excludeHousekeeping: true })).every(e => e.agentType !== 'shell'))).toBe(true)
    await expect(page.getByTestId('first-run-commands-status')).toHaveText('✓ Verified')
    await expect(page.getByTestId('first-run-start-work')).toBeVisible()
  })

  test('hands over to the real dashboard, and does not come back', async () => {
    await page.reload()
    await page.waitForTimeout(2500)
    await openView(page, 'dashboard')
    await page.waitForTimeout(1000)
    expect(await page.locator('[data-testid="first-run-strip"]').count()).toBe(0)
  })

  test('capture setup can be reopened from an existing project and left without losing evidence', async () => {
    // A recorded project must not need its DB wiped to find setup again.
    await post('shell', { subtype: 'command_start', command: 'setup-reopen-evidence' })
    await page.reload()
    await openView(page, 'dashboard')
    await expect(page.getByTestId('first-run-strip')).toHaveCount(0)
    const before = await page.evaluate(async () => (await window.redlog.events.query({ limit: 1000 })).map(e => e.id))
    await resizeMainWindow(app, 800, 720)
    const setup = page.getByTestId('capture-open-setup')
    await expect(setup).toBeVisible()
    await setup.focus()
    await page.keyboard.press('Enter')
    await openCaptureProof(page)
    await expect(page.getByRole('heading', { name: 'Get this engagement fully recorded' })).toBeVisible()
    await expect(page.getByTestId('first-run-commands-status')).toHaveText('✓ Verified')
    await expect(page.getByTestId('first-run-http-status')).toHaveText('○ Not verified')
    await page.getByTestId('first-run-later').click()
    await openView(page, 'dashboard')
    await expect(page.getByTestId('first-run-strip')).toHaveCount(0)
    await expect(setup).toBeVisible()
    const after = await page.evaluate(async () => (await window.redlog.events.query({ limit: 1000 })).map(e => e.id))
    for (const id of before) expect(after).toContain(id)
    await resizeMainWindow(app, 1280, 800)
  })

  test('one terminal session, however many times the view is left and re-entered', async () => {
    // TerminalView keeps its tab list in local state, so it used to spawn a
    // second pty on every visit and orphan the first.
    const pids = async (): Promise<number[]> => page.evaluate(async () =>
      ((await (window as unknown as { redlog: { terminal: { list: () => Promise<Array<{ pid: number }>> } } })
        .redlog.terminal.list()) ?? []).map((s) => s.pid))
    await openView(page, 'terminal')
    await page.waitForTimeout(2000)
    const first = await pids()
    expect(first.length).toBe(1)
    await openView(page, 'timeline')
    await page.waitForTimeout(800)
    await openView(page, 'terminal')
    await page.waitForTimeout(2000)
    expect(await pids(), 'a second shell was spawned').toEqual(first)
  })
})
