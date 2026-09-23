import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let bus: typeof import('../src/core/event-bus')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  bus = await import('../src/core/event-bus')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }
const describeDB = dbAvailable ? describe : describe.skip

type Detector = {
  startProxyBypassDetector(cfg: { engagementId: string; operatorId: string }): void
  stopProxyBypassDetector(): void
}

// Spec 024 removed derived alerts that wrote unsourced rows into the signed
// chain. The proxy-bypass heuristic did the same: a process spawn plus the
// absence of proxy traffic became a chained system row that cited neither.
describeDB('a network tool spawned without proxy traffic', () => {
  let tmpDir: string
  let operatorId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-nobypass-'))
    initDB(tmpDir)
    operatorId = ops.ensurePrimaryOperator('bypass-op', 'Bypass Op', 'tok-' + Math.random()).id
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes nothing to the chain', async () => {
    // Started the way src/main/index.ts starts it, while it exists.
    const detector = await import('../src/main/services/proxy-bypass-detector')
      .then((m) => m as Detector)
      .catch(() => null)
    detector?.startProxyBypassDetector({ engagementId: 'eng-1', operatorId })
    try {
      const spawn = events.insertEvent('process', { subtype: 'process_spawn', command: 'curl http://10.0.0.5/', pid: 4242 }, { operatorId })
      if (spawn) bus.eventBus.publish(spawn)
      await Promise.resolve()
      vi.advanceTimersByTime(20_000)
      const suspected = events.queryEvents({ agentType: 'system', limit: 100 })
        .filter((e) => e.data?.subtype === 'proxy_bypass_suspected')
      expect(suspected).toHaveLength(0)
    } finally {
      detector?.stopProxyBypassDetector()
    }
  })
})

describe('proxy_bypass_suspected', () => {
  it('has no producer left in src', () => {
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && fs.readFileSync(p, 'utf8').includes('proxy_bypass_suspected')) hits.push(p)
      }
    }
    walk(path.join(process.cwd(), 'src'))
    expect(hits).toEqual([])
  })
})
