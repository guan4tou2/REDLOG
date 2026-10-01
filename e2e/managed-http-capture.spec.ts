import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView, openSettingsPage } from './helpers'

test('REDLOG owns HTTP capture and exposes its real state', async () => {
  // The fixture below is a `#!/bin/sh` script standing in for mitmdump, so
  // this has always been a POSIX test — it just never said so, because CI
  // runs e2e on ubuntu. It matters now: capture starts with the project when
  // mitmdump is on PATH, and on Windows the fake one cannot run, so the
  // assertion would fail on the fixture rather than on the behaviour.
  test.skip(process.platform === 'win32', 'the mitmdump stand-in is a shell script')
  // Three proxy transitions now, not two: capture starts with the project, so
  // this asserts that, stops it, and then exercises the explicit start the
  // rest of the spec is about. The old 120s budget was the sum of the polls
  // below and left nothing for the work between them.
  test.setTimeout(180_000)
  const tmpHome = makeTempHome('redlog-managed-http-')
  writeFileSync(join(tmpHome, '.zshrc'), '# Isolated test shell\n')
  const bin = join(tmpHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const fakeMitmdump = join(bin, 'mitmdump')
  // `exec sleep` rather than a trap around a loop: the loop's `sleep` is a
  // grandchild, so SIGTERM is not acted on until the current one returns and
  // the grandchild outlives the shell that owned it. `exec` leaves one
  // process, holding the stderr the proxy reads for its readiness line, and
  // it dies on the signal rather than up to a second later.
  writeFileSync(fakeMitmdump, '#!/bin/sh\necho "HTTP(S) proxy server listening at 127.0.0.1:8080" >&2\nexec sleep 86400\n')
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

    // Capture now starts with the project when mitmdump is on PATH, which it
    // is here — the fake one. The old contract was that a fresh project opens
    // stopped and waits for a button, and that was the wrong default: an
    // operator who opened a project and started working had no HTTP in the
    // record and nothing said so.
    // Auto-start runs at project open and the stand-in announces itself at
    // once, so this is generous rather than a budget to spend.
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()),
      { timeout: 20_000, message: 'opening the project did not start capture' })
      .toMatchObject({ state: 'running' })

    // The control lives in Settings ▸ Browser. It used to be on the first-run
    // card as well, which is what this spec reached for — that copy went when
    // the card stopped carrying a manual, and the spec kept pointing at a
    // testid no source file had.
    await openView(page, 'settings')
    await openSettingsPage(page, 'browser')
    const toggle = page.getByTestId('http-capture-toggle')
    await expect(toggle).toHaveText('Stop HTTP capture')

    // Stop it, so the rest of this spec still exercises the explicit start —
    // the operator's own action, and the only thing that can bring a stopped
    // source back.
    await toggle.click()
    // Stopping is a kill, not a spawn — it does not need a cold-start budget.
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()),
      { timeout: 15_000 }).toMatchObject({ state: 'stopped', url: null })

    // Editing capture settings cannot start a stopped source.
    await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config, httpCapture: { port: 8081, routeTerminals: false } })
    })
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'stopped', url: null })
    // "Restart", not "Start": the control says what pressing it does to a
    // source that has been up once already this session.
    await expect(toggle).toHaveText('Restart HTTP capture')
    await toggle.click()
    // Starting the proxy spawns mitmdump, an external Python process, and
    // waits for it to announce that it is listening. A cold start takes well
    // over `expect.poll`'s 5s default on a real machine, which is why this
    // assertion failed even when the proxy came up perfectly.
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()),
      { timeout: 45_000, message: 'the managed proxy never reported running' })
      .toMatchObject({ state: 'running', url: 'http://127.0.0.1:8081' })
    await expect(toggle).toHaveText('Stop HTTP capture')

    // #220: a capture check is verified only by a report for the nonce the
    // card is showing, delivered through the real API route and IPC. The
    // mitmproxy addon sends these; here the test sends them directly, since
    // the fake mitmdump runs no addon.
    const verifyReport = async (body: Record<string, unknown>): Promise<number> => {
      const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
      const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
      const r = await fetch(`${base}/api/http-verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      })
      return r.status
    }
    // Back to the dashboard: the verification card is on first run, and the
    // toggle above left us in Settings.
    await openView(page, 'dashboard')
    // The nonce comes off the card's own `data-nonce`, not off the per-tool
    // commands. Those commands are the fallback for a check that has not
    // landed, and they are only rendered once the wait has timed out — a
    // minute of this spec's budget to read a value the card has carried
    // since it mounted. Reading them was also the reason this spec failed
    // in a way nothing could see: the element simply was not there.
    const card = page.getByTestId('first-run-http')
    await expect(card).toHaveAttribute('data-nonce', /^rv-/, { timeout: 15_000 })
    const nonce = (await card.getAttribute('data-nonce'))!
    const httpRow = page.getByTestId('first-run-http-check-http')
    expect(await verifyReport({ scheme: 'http', nonce: 'rv-notthisone0' })).toBe(200)
    await page.waitForTimeout(500)
    await expect(httpRow).toHaveAttribute('data-verified', 'false')
    expect(await verifyReport({ scheme: 'http', nonce, user_agent: 'curl/8.5.0' })).toBe(200)
    await expect(httpRow).toHaveAttribute('data-verified', 'true')
    await expect(httpRow).toContainText('curl/8.5.0')
    await expect(page.getByTestId('first-run-http-check-https')).toHaveAttribute('data-verified', 'false')

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

    // Back to the control. It is in Settings now, not on the dashboard card,
    // so the clicks the rest of this spec makes have to go there — the card's
    // copy of the toggle is what this used to press from here.
    await openView(page, 'settings')
    await openSettingsPage(page, 'browser')
    await toggle.click()
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status()))
      .toMatchObject({ state: 'stopped', url: null })
    // "Restart" again: the proxy has been up this session, so stopping it
    // never returns the control to its first-press wording.
    await expect(toggle).toHaveText('Restart HTTP capture')
  } finally {
    await app.close()
  }
})
