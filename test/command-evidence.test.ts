import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB } from '../src/core/db'
import * as events from '../src/core/db/events'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-command-proof-')); initDB(dir) })
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

it('finds real command evidence beyond recent markers and shell bookkeeping', () => {
  events.insertEvent('shell', { subtype: 'command_end', command: 'printf recorded', source: 'auto-relay', stdout: 'recorded' }, { operatorId: 'op' })
  for (let i = 0; i < 25; i++) {
    events.insertEvent('shell', { subtype: 'session_end', source: 'builtin-terminal' }, { operatorId: 'op' })
    events.insertEvent('marker', { text: `marker-${i}` }, { operatorId: 'op' })
  }
  expect(events.commandEvidence()).toEqual({ builtin: false, external: true })
})

it('does not turn shell activation or session rows into command proof', () => {
  events.insertEvent('shell', { subtype: 'session_start' }, { operatorId: 'op' })
  events.insertEvent('shell', { subtype: 'command_end', command: 'source /tmp/shell-zsh-hook.zsh' }, { operatorId: 'op' })
  expect(events.commandEvidence()).toEqual({ builtin: false, external: false })
  events.insertEvent('shell', { subtype: 'command_end', command: 'id', source: 'builtin-terminal' }, { operatorId: 'op' })
  expect(events.commandEvidence()).toEqual({ builtin: true, external: false })
})

it('does not carry evidence into a different project database', () => {
  events.insertEvent('shell', { subtype: 'command', command: 'whoami' }, { operatorId: 'op' })
  closeDB()
  const next = path.join(dir, 'other'); fs.mkdirSync(next); initDB(next)
  expect(events.commandEvidence()).toEqual({ builtin: false, external: false })
})
