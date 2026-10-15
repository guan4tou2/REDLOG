import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { makeTempHome, openTestProject } from './helpers'
import { readCastSlice } from '../src/core/cast-slice'

// Launch the actual self-extracting portable EXE. Connecting to its loopback
// DevTools port avoids substituting win-unpacked for the wrapper being tested.
test('portable wrapper records, exports and finds its evidence after a restart', async () => {
  test.skip(process.platform !== 'win32' || !process.env.REDLOG_PORTABLE_APP, 'Requires the built Windows portable wrapper')
  test.setTimeout(300_000)
  const home = makeTempHome('redlog-portable-')
  const userData = join(home, 'userdata')
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  let diagnostics = ''
  const stop = async (): Promise<void> => {
    if (child?.pid && child.exitCode === null) {
      // Only this test's wrapper tree. This deliberately tests restart after
      // process termination; it is not a claim of graceful portable cleanup.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    }
    await browser?.close().catch(() => {})
    browser = undefined
    if (child && child.exitCode === null) await new Promise<void>(resolve => child!.once('exit', () => resolve()))
    child = undefined
  }
  const launch = async (): Promise<Page> => {
    const portFile = join(userData, 'DevToolsActivePort')
    rmSync(portFile, { force: true })
    child = spawn(process.env.REDLOG_PORTABLE_APP!, [
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userData}`
    ], { env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'test', REDLOG_E2E: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', b => { diagnostics = (diagnostics + b).slice(-8000) })
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject) })
    await expect.poll(() => existsSync(portFile), { timeout: 90_000 }).toBe(true)
    const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
    expect(port).toBeGreaterThan(0)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    let main: Page | undefined
    await expect.poll(async () => {
      for (const p of browser!.contexts().flatMap(c => c.pages())) {
        if (await p.locator('[data-testid="project-picker"], [data-testid="view-root"]').count()) { main = p; return true }
      }
      return false
    }, { timeout: 30_000 }).toBe(true)
    return main!
  }
  const query = (page: Page) => page.evaluate(() => window.redlog.events.query({ limit: 1000 }))
  try {
    let page = await launch()
    const port = readFileSync(join(home, '.redlog', 'api-port'), 'utf8').trim()
    const token = readFileSync(join(home, '.redlog', 'api-token'), 'utf8').trim()
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${token}` } })
    expect(await health.json()).toMatchObject({ ok: true, projectOpen: false })
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'portable-recording')
    await expect(page.locator('.xterm').first()).toContainText(/PS .*>\s*$/, { timeout: 30_000 })
    await page.locator('.xterm-helper-textarea').first().focus()
    await page.keyboard.type('echo portable-builtin-canary')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await query(page)).find(e => e.data.command === 'echo portable-builtin-canary' && e.data.subtype === 'command_end'), { timeout: 30_000 }).toBeTruthy()
    const builtin = (await query(page)).find(e => e.data.command === 'echo portable-builtin-canary' && e.data.subtype === 'command_end')!
    expect(builtin.data.exit_code).toBe(0)
    expect(builtin.data.io).toMatchObject({ ref: expect.any(String) })
    const cast = String((builtin.data.io as { ref: string }).ref)
    await expect.poll(async () => (await readCastSlice(cast, 0, Number.MAX_SAFE_INTEGER))?.text).toMatch(/(?:^|[\r\n])portable-builtin-canary[ \t]*(?:[\r\n]|$)/)
    expect(await page.evaluate(() => window.redlog.hooks.install('shell-powershell'))).toMatchObject({ success: true })
    const hook = join(home, '.redlog', 'shell-hook.ps1')
    expect(existsSync(hook)).toBe(true)
    const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${hook.replace(/'/g, "''")}'`], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'ignore', 'ignore']
    })
    for (const c of ['echo portable-hook-canary', 'cmd /c exit 3', 'exit']) {
      ps.stdin!.write(`${c}\r\n`)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    ps.stdin!.end()
    if (ps.exitCode === null) await new Promise<void>(resolve => ps.once('exit', () => resolve()))
    await expect.poll(async () => (await query(page)).find(e => e.data.command === 'cmd /c exit 3' && e.data.subtype === 'command_end')?.data.exit_code, { timeout: 20_000 }).toBe(3)
    expect((await query(page)).find(e => e.data.command === 'echo portable-hook-canary' && e.data.subtype === 'command_end')?.data.exit_code).toBe(0)
    const plan = await page.evaluate(() => window.redlog.data.resolveExportPlan({ format: 'bundle', subset: { kind: 'all' } }))
    if (!plan.ok) throw new Error(plan.error)
    const result = await page.evaluate(id => window.redlog.data.executeExportPlan({ planId: id }), plan.plan.id)
    if (!result.ok) throw new Error(result.error)
    const dir = result.artifactPath
    const verified = spawnSync('python', [join(dir, 'redlog-verify.py'), dir], { encoding: 'utf8' })
    expect(verified.status, verified.stdout + verified.stderr).toBe(0)
    expect(await page.evaluate(() => window.redlog.hooks.uninstall('shell-powershell'))).toMatchObject({ success: true })
    await stop()
    page = await launch()
    await page.reload()
    await page.waitForSelector('[data-testid="project-picker"], [data-testid="view-root"]')
    if (await page.getByTestId('project-picker').count()) await page.getByText('portable-recording').first().click()
    await expect.poll(async () => (await query(page)).some(e => e.data.command === 'echo portable-builtin-canary'), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => page.evaluate(() => window.redlog.events.searchCasts('portable-builtin-canary', 10)), { timeout: 30_000 }).not.toEqual([])
    console.log('Actual portable wrapper capture verified:', process.env.REDLOG_PORTABLE_APP)
  } catch (error) {
    console.error('Portable wrapper smoke failed:', error)
    console.error('Portable launch state:', { home, exitCode: child?.exitCode, diagnostics })
    throw error
  } finally { await stop() }
})
