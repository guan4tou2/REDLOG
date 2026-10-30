import { test, expect } from '@playwright/test'
import { createServer, get } from 'node:http'
import { dirname } from 'node:path'
import { renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { launchWithTempHome } from './helpers'
const installed = process.env.REDLOG_UPGRADE_INSTALLED
const candidate = process.env.REDLOG_UPGRADE_CANDIDATE

test('Mac manual replacement preserves pre-upgrade evidence and records after the version changes', async () => {
  test.skip(process.platform !== 'darwin' || !installed || !candidate, 'Requires isolated official old install and candidate app paths')
  test.setTimeout(120000)
  let { app, page, tmpHome } = await launchWithTempHome(installed!)
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('upgrade continuity evidence') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const capture = async (path: string) => {
    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status().then(s => s.state)), { timeout: 30000 }).toBe('running')
    const proxy = new URL((await page.evaluate(() => window.redlog.httpCapture.status())).url!)
    await new Promise<void>((resolve, reject) => {
      get({ host: proxy.hostname, port: proxy.port, path: `http://127.0.0.1:${port}/${path}`, headers: { host: `127.0.0.1:${port}` } }, response => { response.resume(); response.on('end', resolve); response.on('error', reject) }).on('error', reject)
    })
    await expect.poll(() => page.evaluate(part => window.redlog.events.query({ agentType: 'scanner', limit: -1 }).then(rows => rows.some(row => row.data.subtype === 'http_response' && String(row.data.url).endsWith('/'+part))), path)).toBe(true)
  }
  try {
    expect(await app.evaluate(({app}) => app.getVersion())).toBe('0.18.3')
    const project = await page.evaluate(() => window.redlog.project.create('manual-upgrade-continuity', { network: { offline: true } }))
    await capture('before-upgrade')
    const original = await page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }))
    const ids = original.map(row => row.id)
    await app.close()
    const appPath = dirname(dirname(dirname(installed!)))
    renameSync(appPath, appPath+'.previous')
    execFileSync('ditto', [candidate!, appPath])
    ;({ app, page } = await launchWithTempHome(installed!, { home: tmpHome }))
    expect(await app.evaluate(({app}) => app.getVersion())).toBe('0.18.4')
    await page.evaluate(id => window.redlog.project.open(id), project.id)
    const reopened = await page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }))
    expect(ids.every(id => reopened.some(row => row.id === id))).toBe(true)
    await capture('after-upgrade')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close() }
})
