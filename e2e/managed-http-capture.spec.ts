import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject } from './helpers'

test('REDLOG owns HTTP capture and exposes its real state', async () => {
  test.setTimeout(120_000)
  const tmpHome = makeTempHome('redlog-managed-http-')
  writeFileSync(join(tmpHome, '.zshrc'), '# Isolated test shell\n')
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
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: ''
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'managed-http')

    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'stopped', url: null })
    // Editing capture settings cannot start a stopped source.
    await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config, httpCapture: { port: 8081, routeTerminals: false } })
    })
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'stopped', url: null })
    await page.getByRole('button', { name: 'Start HTTP capture' }).click()
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'running', url: 'http://127.0.0.1:8081' })
    await expect(page.getByRole('button', { name: 'Stop HTTP capture' })).toBeVisible()

    const terminalProxy = (id: string) => page.evaluate(async (terminalId) => {
      const api = window.redlog.terminal
      let output = ''
      const result = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => { off(); api.kill(terminalId); reject(new Error(`No terminal environment response: ${JSON.stringify(output)}`)) }, 5000)
        const off = api.onData(terminalId, chunk => {
          output += chunk
          const match = output.match(/\r?\nROUTE_VALUE=([^\r\n]*)/)
          if (match) { clearTimeout(timeout); off(); api.kill(terminalId); resolve(match[1]) }
        })
      })
      await api.spawn(terminalId, 80, 24)
      api.write(terminalId, `printf '\\nROUTE_VALUE=%s\\n' "$HTTP_PROXY"\r`)
      return result
    }, id)
    expect(await terminalProxy('routing-off')).toBe('')
    await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config, httpCapture: { port: 8081, routeTerminals: true } })
    })
    expect(await terminalProxy('routing-on')).toBe('http://127.0.0.1:8081')


    await page.getByRole('button', { name: 'Stop HTTP capture' }).click()
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'stopped', url: null })
    await expect(page.getByRole('button', { name: 'Start HTTP capture' })).toBeVisible()
  } finally {
    await app.close()
  }
})
