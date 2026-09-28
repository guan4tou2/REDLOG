import { test, expect, _electron as electron } from '@playwright/test'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createServer as tcpServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject } from './helpers'

const exec = promisify(execFile)
const listen = (server: ReturnType<typeof tcpServer>): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
})

test('real local proxy verifies only the generated client and protocol attempt', async () => {
  test.skip(process.env.REDLOG_REAL_PROXY_TEST !== '1', 'Opt-in local mitmdump + openssl capture smoke')
  test.setTimeout(120_000)
  const home = makeTempHome('redlog-http-verification-')
  const cert = join(home, 'origin.pem')
  const key = join(home, 'origin.key')
  const cnf = join(home, 'origin.cnf')
  writeFileSync(cnf, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', cnf])
  mkdirSync(join(home, '.mitmproxy'), { recursive: true })
  writeFileSync(join(home, '.mitmproxy', 'config.yaml'), `ssl_verify_upstream_trusted_ca: ${JSON.stringify(cert)}\n`)
  const reply = (_req: unknown, res: import('node:http').ServerResponse): void => { res.writeHead(404); res.end('local capture verification') }
  const http = httpServer(reply)
  const https = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, reply)
  const reserve = tcpServer()
  const port = await listen(reserve)
  await new Promise<void>((resolve) => reserve.close(() => resolve()))
  const httpPort = await listen(http)
  const httpsPort = await listen(https)
  const app = await electron.launch({ ...(process.env.REDLOG_PACKAGED_APP ? { executablePath: process.env.REDLOG_PACKAGED_APP } : { args: [MAIN_ENTRY] }), cwd: REPO_ROOT, env: {
    ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'test', REDLOG_E2E: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '', no_proxy: ''
  } })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'http-verification')
    await page.evaluate(async (port) => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config, httpCapture: { port, routeTerminals: false }, browser: { ...config.browser, ignoreCertErrors: true } })
    }, port)
    await page.reload()
    await page.getByTestId('first-run-http').getByRole('button', { name: 'Start HTTP capture', exact: true }).click()
    await page.getByTestId('http-real-request-check').locator('summary').click({ timeout: 25_000 })
    await expect(page.getByTestId('http-verification')).toBeVisible()
    const proxy = `http://127.0.0.1:${port}`
    const generate = async (client: string, url: string): Promise<string> => {
      await page.getByLabel('Client to verify').selectOption(client)
      await page.getByLabel('Authorized read-only test URL').fill(url)
      await page.getByRole('button', { name: 'Generate test', exact: true }).click()
      return (await page.getByTestId('http-test-url').textContent())!
    }
    // Real Chromium browser request, followed by a distinct external curl HTTPS attempt.
    const browserUrl = await generate('browser', `http://127.0.0.1:${httpPort}/browser`)
    await exec('curl', ['--max-time', '15', '--proxy', proxy, '--noproxy', '', `http://127.0.0.1:${httpPort}/unrelated`])
    await expect(page.getByTestId('http-attempt-verified')).toHaveCount(0)
    await app.evaluate(async ({ BrowserWindow, session }, { proxy, url }) => {
      const s = session.fromPartition('verification-browser')
      await s.setProxy({ proxyRules: proxy, proxyBypassRules: '<-loopback>' })
      const browser = new BrowserWindow({ show: false, webPreferences: { session: s } })
      try { await browser.loadURL(url) } finally { browser.destroy() }
    }, { proxy, url: browserUrl })
    await expect(page.getByTestId('http-result-browser-http')).toContainText('404', { timeout: 15_000 })
    await expect(page.getByTestId('http-result-terminal-http')).toContainText('Not tested')
    await generate('terminal', `https://127.0.0.1:${httpsPort}/terminal`)
    await page.getByLabel('Command syntax').selectOption('posix')
    const command = (await page.getByTestId('http-test-command').textContent())!
    await page.getByTestId('http-verification').getByRole('button', { name: 'Copy', exact: true }).click()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(command)
    // Trust only this test proxy in this subprocess; never modify OS trust.
    const ca = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem')
    const reply = await exec('/bin/sh', ['-c', command], { env: { ...process.env, CURL_CA_BUNDLE: ca } })
    expect(reply.stdout).toBe('local capture verification')
    await expect(page.getByTestId('http-result-terminal-https')).toContainText('404', { timeout: 15_000 })
    await expect(page.getByTestId('http-result-browser-https')).toContainText('Not tested')
    await page.screenshot({ path: join(tmpdir(), 'redlog-http-verification.png') })
    const mainWindow = await app.browserWindow(page)
    await mainWindow.evaluate((window) => window.setSize(1000, 850))
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(1000)
    await page.getByLabel('Authorized read-only test URL').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Command syntax')).toBeFocused()
    expect(await page.getByTestId('http-verification').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: join(tmpdir(), 'redlog-http-verification-compact.png') })
    await page.evaluate(() => window.redlog.httpCapture.stop())
    await expect(page.getByTestId('http-verification')).toHaveCount(0)
  } finally {
    await app.close()
    http.closeAllConnections()
    https.closeAllConnections()
    await Promise.all([new Promise<void>((r) => http.close(() => r())), new Promise<void>((r) => https.close(() => r()))])
  }
})
