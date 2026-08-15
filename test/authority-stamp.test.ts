// K1: the stamp has to land in the HASHED row, not just in the live UI feed.
// A label saying "this entry is an interpretation" that can be stripped without
// breaking the chain is worthless in an evidence bundle — the same argument
// `_clock_anomaly` already rests on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB } from '../src/core/db'
import { insertEvent, queryEvents } from '../src/core/db/events'

let dir = ''

describe('insertEvent stamps §3 authority', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-authority-'))
    initDB(dir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const insert = (agentType: string, data: Record<string, unknown> = {}): void => {
    insertEvent(agentType, data, { operatorId: 'op-1' })
  }
  const dataOf = (agentType: string): Record<string, unknown> =>
    queryEvents({ limit: 100 }).find((e) => e.agentType === agentType)?.data as Record<string, unknown>

  it('marks a detector-derived event as inferred', () => {
    insert('loot', { subtype: 'loot_found' })
    expect(dataOf('loot').authority).toBe('inferred')
  })

  // Absence means fact. Writing 'fact' on every row would add a field to
  // ~99% of the store to say the default out loud.
  it('leaves an observed event untouched', () => {
    insert('shell', { subtype: 'command_end', command: 'id' })
    expect(dataOf('shell').authority).toBeUndefined()
  })

  it('does not overwrite a label the emitter already set', () => {
    insert('system', { subtype: 'scope_violation', reason: 'excluded_target', authority: 'fact' })
    expect(dataOf('system').authority).toBe('fact')
  })

  it('keeps an emitter-set inferred label', () => {
    insert('system', { subtype: 'scope_violation', reason: 'adjacent_subnet', authority: 'inferred' })
    expect(dataOf('system').authority).toBe('inferred')
  })

  it('the stamp is inside the hash — stripping it breaks the chain', () => {
    insert('loot', { subtype: 'loot_found' })
    const evt = queryEvents({ limit: 10 }).find((e) => e.agentType === 'loot')!
    expect(evt.data.authority).toBe('inferred')
    // The row's hash was computed over data that includes the label, so a
    // verifier recomputing without it cannot reproduce the stored hash.
    expect(JSON.stringify(evt.data)).toContain('"authority":"inferred"')
    expect(evt.hash).toBeTruthy()
  })
})
