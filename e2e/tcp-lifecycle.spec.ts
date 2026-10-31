import { test, expect, type Page } from '@playwright/test'
import { createServer, type Socket } from 'node:net'
import { request } from 'node:http'
import { launchWithTempHome, requireMitmdump } from './helpers'

// #290: a raw TCP stream through the app's own mitmdump keeps its messages
// and reports how it ended. Non-HTTP bytes inside a CONNECT tunnel are what
// mitmproxy relays as TCP.
async function tunnel(proxy: URL, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const connect = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${port}` })
    connect.on('connect', (_res, socket) => resolve(socket)); connect.on('error', reject); connect.end()
  })
}

const scanner = (page: Page, subtype: string) => page.evaluate(s => window.redlog.events.query({ agentType: 'scanner', limit: -1 })
  .then(rows => rows.filter(row => row.data.subtype === s).map(row => row.data)), subtype)

test('a raw TCP stream keeps its messages and reports a close and a reset', async () => {
  requireMitmdump()
  test.setTimeout(90_000)
  const peers: Socket[] = []
  // Server speaks second: echoes with a prefix, so both directions are seen.
  const server = createServer(socket => { peers.push(socket); socket.on('data', data => socket.write(Buffer.concat([Buffer.from([0xfe]), data]))); socket.on('error', () => {}) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const { app, page } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  const clients: Socket[] = []
  try {
    await page.evaluate(() => window.redlog.project.create('tcp-lifecycle', { network: { offline: true } }))
    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status().then(s => s.state)), { timeout: 30_000 }).toBe('running')
    const proxy = new URL((await page.evaluate(() => window.redlog.httpCapture.status())).url!)

    // Normal close.
    const a = await tunnel(proxy, port); clients.push(a)
    a.on('error', () => {})
    const echoed = new Promise<Buffer>(resolve => a.once('data', resolve))
    a.write(Buffer.from([0x00, 0x01, 0x02, 0xff, 0x10]))
    expect(await echoed).toEqual(Buffer.from([0xfe, 0x00, 0x01, 0x02, 0xff, 0x10]))
    await expect.poll(async () => (await scanner(page, 'tcp_message')).length).toBe(2)
    a.end()
    await expect.poll(async () => (await scanner(page, 'tcp_end')).length, { timeout: 15_000 }).toBe(1)
    const closed = (await scanner(page, 'tcp_end'))[0]
    const flowA = String(closed.flow_id)
    console.log('[TCP] close:', JSON.stringify(closed))
    expect(closed).toMatchObject({ stream_state: 'ended', message_count_observed: 2, capture_delivery: 'unknown' })
    expect(await page.evaluate(id => window.redlog.events.streamCompletion(id), flowA)).toEqual({ state: 'end-observed', saved: 2 })

    // The upstream resets mid-stream.
    const b = await tunnel(proxy, port); clients.push(b)
    b.on('error', () => {})
    const echoedB = new Promise<Buffer>(resolve => b.once('data', resolve))
    b.write(Buffer.from('before reset'))
    await echoedB
    await expect.poll(async () => (await scanner(page, 'tcp_message')).length).toBe(4)
    peers[peers.length - 1].resetAndDestroy()
    await expect.poll(async () => (await scanner(page, 'tcp_end')).length, { timeout: 15_000 }).toBe(2)
    const reset = (await scanner(page, 'tcp_end')).find(row => row.flow_id !== flowA)!
    console.log('[TCP] reset:', JSON.stringify(reset))
    // What mitmproxy surfaces for a reset is recorded either way; the stream
    // must never read as more complete than the close says.
    const completion = await page.evaluate(id => window.redlog.events.streamCompletion(id), String(reset.flow_id))
    console.log('[TCP] reset completion:', JSON.stringify(completion))
    expect(reset.message_count_observed).toBe(2)
    expect(completion?.saved).toBe(2)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    for (const c of clients) c.destroy()
    for (const p of peers) p.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await app.close()
  }
})
