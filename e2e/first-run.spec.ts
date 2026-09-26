import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

// Design turn 9a. Two claims only the real app can settle: that the first
// screen of a new engagement is the single-path one, and that it gets out of
// the way for good once something has been captured.

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

test.describe.serial('the first run', () => {
  test.beforeAll(async () => {
    tmpHome = makeTempHome('redlog-firstrun-')
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'first-run')
    await page.waitForTimeout(2000)
    await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000) })
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('opens on the single-path screen, unlit', async () => {
    // The rows the app writes about itself on project open — a session start,
    // an IP verdict — must not count as the operator having done something.
    const strip = page.locator('[data-testid="first-run-strip"]')
    await expect(strip).toBeVisible()
    await expect(strip).toHaveAttribute('data-first-run-lit', 'false')
  })

  test('keeps the ten capture sources one disclosure away', async () => {
    await expect(page.locator('[data-testid="first-run-more-sources"]')).toBeVisible()
    await page.click('[data-testid="first-run-more-sources"]')
    await page.waitForTimeout(500)
    expect(await page.locator('text=/capture|Capture/').count()).toBeGreaterThan(0)
    await expect(page.getByText('commands only · redlog-run adds stdout/stderr').first()).toBeVisible()
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
    await expect(page.locator('[data-testid="first-run-builtin-only"]')).toBeVisible()
  })

  test('hands over to the real dashboard, and does not come back', async () => {
    await page.reload()
    await page.waitForTimeout(2500)
    await openView(page, 'dashboard')
    await page.waitForTimeout(1000)
    expect(await page.locator('[data-testid="first-run-strip"]').count()).toBe(0)
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
