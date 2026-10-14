import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempHome, openTestProject } from './helpers'
import { findShellTarget, runZsh } from '../test/helpers/zsh-pty'

test('installed Zsh preserves all 100 commands, output and failure boundaries in the actual project', async () => {
  test.skip(process.platform !== 'darwin' || !process.env.REDLOG_PACKAGED_APP, 'Requires a current macOS package')
  test.setTimeout(240_000)
  const shell = findShellTarget()
  expect(shell).toBeTruthy()
  const home = makeTempHome('redlog-package-100-')
  const app = await electron.launch({ executablePath: process.env.REDLOG_PACKAGED_APP!, env: {
    ...process.env, HOME: home, USERPROFILE: home, REDLOG_E2E: '1', NODE_ENV: 'test'
  } })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, '100-command-integrity')
    expect(await page.evaluate(() => window.redlog.hooks.install('shell-zsh'))).toMatchObject({ success: true })
    const commands = Array.from({ length: 100 }, (_, n) => n % 10 === 9
      ? `sh -c 'printf output-${n}; printf error-${n} >&2; exit 3'`
      : n % 10 === 7 ? `echo output-${n}; echo error-${n} >&2`
      : `echo output-${n}`)
    const started = Date.now()
    const result = await runZsh(shell!, {
      rc: readFileSync(join(home, '.zshrc'), 'utf8'), commands, timeoutSeconds: 180,
      env: { _REDLOG_DIR: join(home, '.redlog'), REDLOG_EXTERNAL_SESSION: '', REDLOG_TERMINAL: '' }
    })
    expect(result.ok, result.error).toBe(true)
    expect(result.steps).toHaveLength(100)
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ limit: 1000 })).filter(e =>
      e.data.subtype === 'command_end' && String(e.data.command ?? '').includes('output-')).length), { timeout: 20_000 }).toBe(100)
    const rows = await page.evaluate(() => window.redlog.events.query({ limit: 1000 }))
    for (let n = 0; n < commands.length; n++) {
      expect(result.steps[n].output).toContain(`output-${n}`)
      const ends = rows.filter(e => e.data.subtype === 'command_end' && e.data.command === commands[n])
      expect(ends, commands[n]).toHaveLength(1)
      expect(ends[0].data).toMatchObject({ shell: 'zsh', source: 'auto-relay', exit_code: n % 10 === 9 ? 3 : 0, stdout: expect.stringContaining(`output-${n}`) })
      if (n % 10 === 9 || n % 10 === 7) {
        expect(result.steps[n].output).toContain(`error-${n}`)
        expect(ends[0].data.stderr).toContain(`error-${n}`)
      }
    }
    console.log('100-command installed recording evidence:', { home, elapsedMs: Date.now() - started })
  } catch (error) {
    console.error('100-command package integrity failed:', error)
    throw error
  } finally {
    await app.close()
  }
})
