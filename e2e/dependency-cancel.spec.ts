import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, resizeMainWindow } from './helpers'

// Controlled installer process, real IPC and real process-tree cancellation.
// The separate opt-in dependency-install journey tests public downloads.
test('cancelling preparation stops its installer tree while another process survives', async () => {
  test.skip(process.platform === 'win32', 'This controlled uv fixture is a POSIX executable')
  test.setTimeout(90_000)
  const home = makeTempHome('redlog-install-cancel-')
  const bin = join(home, 'bin')
  const ids = join(home, 'owned-installer.json')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), `#!${process.execPath}
const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const target = ${JSON.stringify(ids)};
fs.writeFileSync(target + '.tmp', JSON.stringify([process.pid, child.pid]));
fs.renameSync(target + '.tmp', target);
console.log('Controlled dependency download remains pending');
setInterval(() => {}, 1000);
`, { mode: 0o755 })
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const app = await electron.launch({
    ...(process.env.REDLOG_PACKAGED_APP ? { executablePath: process.env.REDLOG_PACKAGED_APP } : {}),
    args: [...(process.env.REDLOG_PACKAGED_APP ? [] : [MAIN_ENTRY]), `--user-data-dir=${join(home, 'userdata')}`],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'test', REDLOG_E2E: '1' }
  })
  const running = (pid: number): boolean => {
    const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim()
    return state !== '' && !state.startsWith('Z')
  }
  let owned: number[] = []
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.evaluate(() => window.redlog.runtime.preflight())
    await app.evaluate((_electron, bin) => { process.env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }, bin)
    await openTestProject(page, 'cancel-install')
    await resizeMainWindow(app, 800, 720)
    const start = page.getByTestId('prepare-install-mitmdump')
    await start.click()
    await expect(page.getByTestId('prepare-install-status-mitmdump')).toContainText('15 minutes')
    await expect.poll(() => existsSync(ids)).toBe(true)
    owned = JSON.parse(readFileSync(ids, 'utf8')) as number[]
    expect(owned).toHaveLength(2)
    expect(owned.every(running)).toBe(true)
    const cancel = page.getByTestId('prepare-cancel-mitmdump')
    await page.screenshot({ path: test.info().outputPath('pending-install-800.png') })
    await cancel.focus()
    await cancel.press('Enter')
    await expect(page.getByTestId('prepare-cancelled-mitmdump')).toBeVisible()
    await expect(start).toBeEnabled()
    await expect.poll(() => owned.some(running)).toBe(false)
    expect(running(other.pid!)).toBe(true)
    await expect(page.getByTestId('prepare-error-mitmdump')).toHaveCount(0)
    await expect(page.getByTestId('first-run-http-status')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('cancelled-install-800.png') })
    await start.click()
    await expect(page.getByTestId('prepare-install-status-mitmdump')).toBeVisible()
    await expect.poll(() => JSON.parse(readFileSync(ids, 'utf8'))[0] !== owned[0]).toBe(true)
    owned.push(...JSON.parse(readFileSync(ids, 'utf8')) as number[])
    await page.getByTestId('capture-prepare-skip').click()
    await expect(page.getByTestId('first-run-http-status')).toHaveText('○ Not verified')
    await expect.poll(() => owned.some(running)).toBe(false)
    await page.getByTestId('first-run-http-prepare').click()
    await page.getByTestId('prepare-install-mitmdump').click()
    const previous = owned.at(-2)
    await expect.poll(() => JSON.parse(readFileSync(ids, 'utf8'))[0] !== previous).toBe(true)
    owned.push(...JSON.parse(readFileSync(ids, 'utf8')) as number[])
    await page.reload()
    await expect.poll(() => owned.some(running), { timeout: 5000 }).toBe(false)
  } catch (error) {
    console.error('Installer cancellation journey failed:', error)
    throw error
  } finally {
    await app.close()
    other.kill('SIGKILL')
    for (const pid of owned) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
})
