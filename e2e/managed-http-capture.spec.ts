import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject } from './helpers'

test('REDLOG owns HTTP capture and exposes its real state', async () => {
  test.setTimeout(120_000)
  const tmpHome = makeTempHome('redlog-managed-http-')
  const bin = join(tmpHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const fakeMitmdump = join(bin, 'mitmdump')
  writeFileSync(fakeMitmdump, '#!/bin/sh\necho "HTTP(S) proxy server listening at 127.0.0.1:8080" >&2\ntrap "exit 0" TERM INT\nwhile :; do sleep 1; done\n')
  chmodSync(fakeMitmdump, 0o755)

  const app = await electron.launch({
    args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1',
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'managed-http')

    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'running', url: 'http://127.0.0.1:8080' })
    await expect(page.getByRole('button', { name: 'Stop HTTP capture' })).toBeVisible()

    await page.getByRole('button', { name: 'Stop HTTP capture' }).click()
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'stopped', url: null })
    await expect(page.getByRole('button', { name: 'Start HTTP capture' })).toBeVisible()
  } finally {
    await app.close()
  }
})

