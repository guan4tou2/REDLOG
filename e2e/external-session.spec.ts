import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { launchWithTempHome, openTestProject, openView, REPO_ROOT } from './helpers'

test('external PTY output remains searchable and exportable while paused', async () => {
  test.setTimeout(90_000)
  test.skip(process.platform === 'win32', 'POSIX PTY launcher')
  const { app, page, tmpHome } = await test.step('launch isolated app', () => launchWithTempHome())
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'external-session')
    const child = spawn('python3', ['hooks/redlog-session.py', '--', '/bin/sh', '-c', 'printf external-pty-canary'], {
      cwd: REPO_ROOT, env: { ...process.env, HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let diagnostics = ''
    child.stderr.on('data', b => { diagnostics += b })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code, diagnostics).toBe(0)
    await page.getByTestId('status-bar-recording').click()
    await expect(page.getByTestId('status-bar-recording')).toHaveAttribute('data-recording', 'off')
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+4`)
    await expect(page.locator('[data-view="transcript"]')).toBeVisible()
    await page.getByRole('button', { name: '▶ 19 B' }).click()
    await expect(page.getByText('external-pty-canary', { exact: true })).toBeVisible()
    await openView(page, 'search')
    await page.getByTestId('search-input').fill('external-pty-canary')
    await expect(page.getByText(/PTY #1: external-pty-canary/)).toBeVisible()
    await page.getByLabel('Export', { exact: true }).click()
    await page.getByText('Everything', { exact: true }).click()
    await expect(page.getByText('Plan fingerprint')).toBeVisible()
    await page.locator('button.bg-red-600').filter({ hasText: 'Export' }).click()
    await expect(page.getByText('Exported Everything')).toBeVisible()
  } finally {
    await app.close()
  }
})
