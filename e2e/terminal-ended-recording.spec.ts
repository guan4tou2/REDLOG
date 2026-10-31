import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchWithTempHome, openTestProject, openView } from './helpers'

// #290: a pane whose shell has exited still says what its recording went
// through. Paused for part of the session is not the same as recorded whole,
// and the tab used to drop every badge the moment the shell exited.
test('an ended pane keeps saying its recording was paused for part of the session', async () => {
  test.skip(process.platform === 'win32', 'POSIX shell interaction; native PowerShell acceptance has its own matrix')
  test.setTimeout(90_000)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    // A fresh HOME with no startup files sends zsh into its newuser wizard.
    fs.writeFileSync(path.join(tmpHome, '.zshrc'), '# Isolated ended-recording test shell\n')
    await page.evaluate(async () => {
      localStorage.setItem('redlog-locale', 'en')
      const zsh = (await window.redlog.terminal.shells()).find(shell => /\bzsh\b/i.test(shell.label))
      if (!zsh) throw new Error('This journey requires Zsh; install it before running the test')
      localStorage.setItem('redlog-terminal-shell', zsh.id)
    })
    await openTestProject(page, 'ended-recording')
    await openView(page, 'terminal')
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list()).length)).toBe(1)
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list())[0].recording)).toBe(true)
    // Wait for enrollment injection so the redlog verbs exist in the shell.
    await page.waitForTimeout(900)
    await page.locator('.xterm-helper-textarea').focus()

    await page.keyboard.type('redlog stop'); await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list())[0].paused)).toBe(true)
    await page.keyboard.type('redlog start'); await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list())[0].recording)).toBe(true)
    await expect(page.getByTestId('terminal-ended-recording')).toHaveCount(0)

    await page.keyboard.type('exit'); await page.keyboard.press('Enter')
    const badge = page.getByTestId('terminal-ended-recording')
    await expect(badge).toHaveAttribute('data-state', 'partly-paused', { timeout: 20_000 })
    await expect(badge).toHaveText('part paused')
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
  }
})
