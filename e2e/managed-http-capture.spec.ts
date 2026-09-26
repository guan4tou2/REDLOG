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
    // The app-wide toggle, not the first-run card's button: a fresh project
    // opens on first run, where both are on screen (#217).
    const toggle = page.getByTestId('http-capture-toggle')
    await expect(toggle).toHaveText('Start HTTP capture')
    await toggle.click()
    // Starting the proxy spawns mitmdump, an external Python process, and
    // waits for it to announce that it is listening. A cold start takes well
    // over `expect.poll`'s 5s default on a real machine, which is why this
    // assertion failed even when the proxy came up perfectly.
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()),
      { timeout: 45_000, message: 'the managed proxy never reported running' })
      .toMatchObject({ state: 'running', url: 'http://127.0.0.1:8081' })
    await expect(toggle).toHaveText('Stop HTTP capture')

    const terminalProxy = (id: string) => page.evaluate(async (terminalId) => {
      const api = window.redlog.terminal
      let output = ''
      const result = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => { off(); api.kill(terminalId); reject(new Error(`No terminal environment response: ${JSON.stringify(output)}`)) }, 15000)
        const off = api.onData(terminalId, chunk => {
          output += chunk
          // The pty does not always reach the marker with a newline: on a
          // wrapped line it repositions the cursor instead, so the bytes
          // arrive as `\u001b[5;1HROUTE_VALUE=`. Match the marker itself,
          // not whatever happens to precede it.
          const match = output.match(/ROUTE_VALUE=([^\r\n\u001b]*)/)
          if (match) { clearTimeout(timeout); off(); api.kill(terminalId); resolve(match[1]) }
        })
      })
      await api.spawn(terminalId, 80, 24)
      // The built-in terminal sources the adapter into the fresh pty 600ms
      // after spawn and clears the screen. Writing into that window races
      // it, and the printf's output is wiped by the `clear` that follows.
      await new Promise((r) => setTimeout(r, 1500))
      // The marker is assembled BY printf, so the shell echo of the typed
      // line contains `ROUTE_%s=` while only the OUTPUT contains
      // `ROUTE_VALUE=`. A preceding newline used to do that job, but the
      // pty reaches a wrapped line with a cursor move instead.
      api.write(terminalId, `printf '\\nROUTE_%s=%s\\n' VALUE "$HTTP_PROXY"\r`)
      return result
    }, id)
    expect(await terminalProxy('routing-off')).toBe('')
    await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config, httpCapture: { port: 8081, routeTerminals: true } })
    })
    expect(await terminalProxy('routing-on')).toBe('http://127.0.0.1:8081')


    await toggle.click()
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'stopped', url: null })
    await expect(toggle).toHaveText('Start HTTP capture')
  } finally {
    await app.close()
  }
})
