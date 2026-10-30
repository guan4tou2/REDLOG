import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createServer, get, type ServerResponse } from 'node:http'
import { spawnSync } from 'node:child_process'
import { launchWithTempHome } from './helpers'

test('SSE reaches persisted events before completion and pause refuses bytes without later replay', async () => {
  test.skip(spawnSync('mitmdump', ['--version'], { timeout: 5000 }).status !== 0, 'Requires installed mitmdump for real source acceptance')
  test.setTimeout(90000)
  const { app, page } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  let output: ServerResponse | undefined
  const server = createServer((_req, res) => { output = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first 中文\n\n') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let client: ReturnType<typeof get> | undefined
  try {
    await page.evaluate(() => window.redlog.project.create('sse-preservation', { network: { offline: true } }))
    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status())).toMatchObject({ state: 'running' })
    const status = await page.evaluate(() => window.redlog.httpCapture.status())
    const proxy = new URL(status.url!)
    let received = ''
    client = get({ host: proxy.hostname, port: proxy.port, path: `http://127.0.0.1:${port}/events`, headers: { host: `127.0.0.1:${port}` } }, res => { res.on('data', data => { received += data.toString() }); res.on('error', () => {}) })
    client.on('error', () => {})
    const chunks = () => page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }).then(rows => rows.filter(row => row.data.subtype === 'http_response_chunk')))
    await expect.poll(async () => (await chunks()).length).toBeGreaterThan(0)
    expect(output?.writableEnded).toBe(false)
    await page.evaluate(() => window.redlog.recording.toggle())
    output!.write('data: private-paused\n\n')
    await expect.poll(() => received).toContain('private-paused')
    // Prove the API processed the refusal before resume; streaming delivery to
    // the client is independent from the recording gate.
    await page.waitForTimeout(400)
    await page.evaluate(() => window.redlog.recording.toggle())
    output!.write('data: after-resume\n\n')
    await expect.poll(async () => (await chunks()).length).toBe(2)
    const rows = await chunks()
    expect(rows.map(row => row.data.seq).sort()).toEqual([1, 3])
    expect(rows.every(row => row.data.response_body || row.data.response_body_ref)).toBe(true)
    expect(rows.every(row => row.tier === 'logged')).toBe(true)
    output!.end()
    await expect.poll(() => page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }).then(rows => rows.some(row => row.data.subtype === 'http_response' && row.data.stream_state === 'ended')))).toBe(true)
    // A second source dies before EOF. Its committed prefix survives and the
    // terminal Event must report interruption, not a normal empty response.
    client = get({ host: proxy.hostname, port: proxy.port, path: `http://127.0.0.1:${port}/broken`, headers: { host: `127.0.0.1:${port}` } }, res => { res.on('data', () => {}); res.on('error', () => {}) })
    client.on('error', () => {})
    await expect.poll(async () => (await chunks()).length).toBe(3)
    output!.destroy()
    await expect.poll(() => page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }).then(rows => rows.some(row => row.data.subtype === 'http_error' && row.data.stream_state === 'interrupted')))).toBe(true)
    expect((await chunks()).length).toBe(3)
    const exported = await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config!, scope: { ...config!.scope, personalDomains: [] } })
      const plan = await window.redlog.data.resolveExportPlan({ format: 'har' })
      if (!plan.ok) throw new Error(String(plan.error))
      return window.redlog.data.executeExportPlan({ planId: plan.plan.id })
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error('HAR failed')
    const har = JSON.parse(readFileSync(exported.artifactPath, 'utf8'))
    const parts = har.log.entries.flatMap((entry: any) => entry._redlog.streamChunks ?? [])
    expect(parts).toHaveLength(3)
    const text = parts.map((part: any) => part.body.encoding === 'base64' ? Buffer.from(part.body.text, 'base64').toString('utf8') : part.body.text).join('')
    expect(text).toContain('first 中文')
    expect(text).toContain('after-resume')
    expect(text).not.toContain('private-paused')


  } catch (error) {
    console.log('SSE source status:', await page.evaluate(() => window.redlog.httpCapture.status()))
    throw error
  } finally {
    client?.destroy(); output?.destroy(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await app.close()
  }
})

test('WebSocket messages persist before close, retain binary bytes in HAR and record an abnormal close', async () => {
  test.skip(spawnSync('mitmdump', ['--version'], { timeout: 5000 }).status !== 0, 'Requires installed mitmdump')
  test.setTimeout(90000)
  const { WebSocket, WebSocketServer } = await import('ws')
  const { request } = await import('node:http')
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.on('listening', resolve))
  server.on('connection', socket => socket.on('message', () => socket.send(Buffer.from([0, 255, 27, 10]))))
  const port = (server.address() as { port: number }).port
  const { app, page } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  let client: InstanceType<typeof WebSocket> | undefined
  let tunnel: import('node:net').Socket | undefined
  try {
    await page.evaluate(() => window.redlog.project.create('ws-preservation', { network: { offline: true } }))
    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status().then(s => s.state)), { timeout: 30000 }).toBe('running')
    const proxy = new URL((await page.evaluate(() => window.redlog.httpCapture.status())).url!)
    tunnel = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const connect = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${port}` })
      connect.on('connect', (_response, socket) => resolve(socket)); connect.on('error', reject); connect.end()
    })
    client = new WebSocket(`ws://127.0.0.1:${port}/socket`, { createConnection: () => tunnel! })
    client.on('error', () => {})
    await new Promise<void>((resolve, reject) => { client!.once('open', resolve); client!.once('error', reject) })
    const reply = new Promise<Buffer>(resolve => client!.once('message', data => resolve(Buffer.from(data as Buffer))))
    client.send('client-message 中文')
    expect(await reply).toEqual(Buffer.from([0, 255, 27, 10]))
    await expect.poll(() => page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }).then(rows => rows.filter(row => row.data.subtype === 'ws_message').length))).toBe(2)
    expect(client.readyState).toBe(WebSocket.OPEN)
    client.terminate()
    await expect.poll(() => page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }).then(rows => rows.some(row => row.data.subtype === 'websocket_end' && row.data.stream_state === 'interrupted')))).toBe(true)
    const exported = await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config!, scope: { ...config!.scope, personalDomains: [] } })
      const plan = await window.redlog.data.resolveExportPlan({ format: 'har' })
      if (!plan.ok) throw new Error('HAR resolve failed')
      return window.redlog.data.executeExportPlan({ planId: plan.plan.id })
    })
    if (!exported.ok) throw new Error('HAR execute failed')
    const har = JSON.parse(readFileSync(exported.artifactPath, 'utf8'))
    const messages = har.log.entries.flatMap((entry: any) => entry._redlog.webSocketMessages ?? [])
    expect(messages).toHaveLength(2)
    expect(messages.map((message: any) => message.direction).sort()).toEqual(['client', 'server'])
    const binary = messages.find((message: any) => message.direction === 'server')
    expect(Buffer.from(binary.body.text, 'base64')).toEqual(Buffer.from([0, 255, 27, 10]))
  } finally {
    client?.terminate(); tunnel?.destroy(); for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve())); await app.close()
  }
})
