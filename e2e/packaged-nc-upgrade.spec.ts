import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { makeTempHome, openTestProject } from './helpers'
import { findShellTarget, runZsh, type ZshReport } from '../test/helpers/zsh-pty'

// Actual installed app + native Linux PTYs. This complements the collector
// unit test; it does not relabel an automated run as the manual Kali task.
test('installed capture preserves the loopback nc upgrade and records its honest boundary', async () => {
  test.skip(process.platform !== 'linux' || !process.env.REDLOG_PACKAGED_APP,
    'Requires an installed Linux package and traditional netcat')
  const banner = spawnSync('nc', ['-h'], { encoding: 'utf8' })
  expect(`${banner.stdout}${banner.stderr}`, 'Install traditional netcat before this acceptance run').toMatch(/v1\.10/)
  test.setTimeout(180_000)
  const home = makeTempHome('redlog-installed-nc-')
  const app = await electron.launch({ executablePath: process.env.REDLOG_PACKAGED_APP!, args: [`--user-data-dir=${join(home, 'userdata')}`], env: {
    ...process.env, HOME: home, USERPROFILE: home, REDLOG_E2E: '1', NODE_ENV: 'test'
  } })
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, 'native-nc-upgrade')
    expect(await page.evaluate(() => window.redlog.hooks.install('shell-zsh'))).toMatchObject({ success: true })
    const target = findShellTarget()
    expect(target).toBeTruthy()
    const upgraded = async (rc: string): Promise<{ report: ZshReport; command: string }> => {
      const server = createServer()
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      const command = `nc -lvnp ${port} -s 127.0.0.1`
      // Match only this test's exact, loopback-only listener. Never pkill nc:
      // another pane may be holding a real operator session.
      const ownPid = `p=$(pgrep -f '^${command}$'); test -n "$p" || exit 1; `
      const report = await runZsh(target!, {
        rc, env: { _REDLOG_DIR: join(home, '.redlog'), REDLOG_TERMINAL: '', REDLOG_EXTERNAL_SESSION: '' },
        commands: [
          'stty -g', { line: command, until: 'listening on' }, { raw: '\u001a' }, 'jobs',
          { line: 'stty raw -echo; fg', until: 'continued' },
          { sh: `${ownPid}for f in 0 1 2; do readlink /proc/$p/fd/$f; done` },
          { peer: { port, send: 'redlog-owned-loopback-peer\n', hold: 0.6 } },
          { sh: `${ownPid}sleep 0.5; kill "$p"` }, { prompt: true }, 'stty -g'
        ], timeoutSeconds: 30, totalTimeoutSeconds: 90
      })
      return { report, command }
    }
    const bare = await upgraded('# No adapter in the baseline shell')
    const adapted = await upgraded(readFileSync(join(home, '.zshrc'), 'utf8'))
    for (const { report } of [bare, adapted]) {
      expect(report.ok, report.error).toBe(true)
      expect(report.steps[2].output).toContain('suspended')
      expect(report.steps[3].output).toMatch(/suspended.*nc/)
      expect(report.steps[4].output).toContain('continued')
      const fds = report.steps[5].output.trim().split('\n')
      expect(fds).toHaveLength(3)
      for (const fd of fds) expect(fd.trim()).toMatch(/^\/dev\/pts\//)
      expect(report.steps[8].output).toContain('redlog-owned-loopback-peer')
    }
    expect(adapted.report.steps[0].output.trim()).toBe(bare.report.steps[0].output.trim())
    expect(adapted.report.steps[9].output.trim()).toBe(bare.report.steps[9].output.trim())
    const start = await page.evaluate(async command =>
      (await window.redlog.events.query({ agentType: 'shell', limit: -1 }))
        .find(e => e.data.subtype === 'command_start' && e.data.command === command)?.data,
      adapted.command)
    // Classification belongs to command_start; command_end describes what
    // was saved. Assert both actual contracts rather than inventing a field.
    expect(start).toMatchObject({ class: 'native' })
    await expect.poll(() => page.evaluate(async command =>
      (await window.redlog.events.query({ agentType: 'shell', limit: -1 }))
        .find(e => e.data.subtype === 'command_end' && e.data.command === command)?.data,
      adapted.command), { timeout: 15_000 }).toMatchObject({
      completeness: 'metadata-only', output_disposition: 'interactive'
    })
    const end = await page.evaluate(async command =>
      (await window.redlog.events.query({ agentType: 'shell', limit: -1 }))
        .find(e => e.data.subtype === 'command_end' && e.data.command === command)?.data,
      adapted.command)
    expect(end).not.toHaveProperty('stdout')
    expect(end).not.toHaveProperty('stdout_ref')
    expect(await page.evaluate(() => window.redlog.chain.verify())).toMatchObject({ ok: true })
    console.log('Installed native nc upgrade:', { platform: process.platform, architecture: process.arch, home })
  } catch (error) {
    console.error('Installed nc upgrade failed:', error)
    throw error
  } finally { await app.close() }
})
