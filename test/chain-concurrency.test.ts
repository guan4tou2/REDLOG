import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.11.1 (AUDIT P1-1): a full chain verify must not stop capture.
//
// verifyChainFullAsync yields with setImmediate between chunks so the UI keeps
// painting, but better-sqlite3's iterator holds its connection open across
// those yields — and the library refuses `.run()` on a connection with a live
// iterator ("This database connection is busy executing a query"). On the
// primary handle that meant every captured event during a verify failed: REST
// 500s, the shell hook spooling to disk, capture-health going dark, for the
// tens of seconds a large chain takes.
//
// The old code comment argued it was safe "as long as no interleaving
// statement is issued against the same DB". Background capture is exactly an
// interleaving statement — the premise was wrong, not the reasoning.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let verifyChainFullAsync: typeof import('../src/core/chain-anchor').verifyChainFullAsync

let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  const e = await import('../src/core/db/events')
  const c = await import('../src/core/chain-anchor')
  initDB = d.initDB; closeDB = d.closeDB; insertEvent = e.insertEvent
  verifyChainFullAsync = c.verifyChainFullAsync
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('chain verify vs live capture', () => {
  it('capture keeps writing while a full walk is in progress', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-conc-'))
    initDB(dir)
    // Enough rows that the walk spans several setImmediate yields — the whole
    // point is to have inserts land *inside* the iterator's lifetime.
    for (let i = 0; i < 6000; i++) {
      insertEvent('shell', { subtype: 'command_end', command: `seed-${i}` }, { engagementId: 'e', operatorId: 'op' })
    }

    let insertErr: Error | null = null
    let landed = 0
    const walk = verifyChainFullAsync()
    const capture = (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setImmediate(r))
        try {
          if (insertEvent('shell', { subtype: 'command_end', command: `live-${i}` }, { engagementId: 'e', operatorId: 'op' })) landed++
        } catch (e) { insertErr = e as Error; break }
      }
    })()

    const [result] = await Promise.all([walk, capture])
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })

    expect(insertErr && (insertErr as Error).message, 'capture must not be locked out by a verify').toBeFalsy()
    expect(landed, 'events fired during the walk should have landed').toBeGreaterThan(0)
    expect(result.ok, 'the walk itself must still succeed').toBe(true)
    expect(result.walked).toBeGreaterThanOrEqual(6000)
  }, 300000)
})
