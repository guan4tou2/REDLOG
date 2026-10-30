import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'

// A navigation poll in flight when its project closes. The monitor kept the
// closed project's identity, so the answer was written into the next project
// under the old engagement, and the same poll opened fresh tab sockets that
// went on writing the browser's console into it until the tab closed.

let dbmod: typeof import('../src/core/db/index') | null = null
let events: typeof import('../src/core/db/events') | null = null
let cdp: typeof import('../src/main/services/cdp-connector') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  dbmod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  cdp = await import('../src/main/services/cdp-connector')
} catch { /* better-sqlite3 not built for this Node ABI */ }

describe.skipIf(cdp === null)('stopping the browser monitor mid-poll', () => {
  let dir: string
  let server: http.Server
  let socketAttempts = 0
  let holdList: ((tabs: unknown[]) => void) | null = null
  let listAskedResolve!: () => void
  const listAsked = new Promise<void>((resolve) => { listAskedResolve = resolve })

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cdp-stop-'))
    dbmod!.initDB(dir)
    server = http.createServer((req, res) => {
      if (req.url === '/json') {
        holdList = (tabs) => { res.writeHead(200).end(JSON.stringify(tabs)) }
        listAskedResolve()
        return
      }
      res.writeHead(404).end()
    })
    server.on('upgrade', (_req, socket) => { socketAttempts++; socket.destroy() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })
  afterEach(async () => {
    cdp!.stopCdpMonitor()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes nothing and opens no tab socket once stopped', async () => {
    const port = (server.address() as AddressInfo).port
    cdp!.setCdpPort(port)
    cdp!.configureCdpMonitor({ engagementId: 'eng-a', operatorId: 'op', enabled: true })
    // The poll runs every 3 s; wait for it to ask, then stop before answering.
    await listAsked
    cdp!.stopCdpMonitor()
    holdList!([{
      id: 'tab-1', type: 'page', url: 'https://target.example/login', title: 'login',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab-1`
    }])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(events!.queryEvents({ limit: -1, tier: 'all' })).toHaveLength(0)
    expect(socketAttempts).toBe(0)
  }, 10_000)
})
