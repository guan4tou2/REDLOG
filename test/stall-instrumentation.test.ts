import { describe, it, expect, vi } from 'vitest'
import fs, { fsyncSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { installStallTiming, createStallTiming } from './helpers/stall-timing'

describe('stall timing', () => {
  function fixture(enabled = true) {
    let time = 0
    const lines: string[] = []
    const timing = createStallTiming({ enabled, now: () => time, write: line => lines.push(line) })
    return { timing, lines, advance: (ms: number) => { time += ms } }
  }
  it('is silent below 250ms, preserves this and return, and prints the argument tail', () => {
    const f = fixture()
    const receiver = { value: 42 }
    const call = f.timing.wrap('fs.openSync', function (this: typeof receiver, _arg: string, ms: number) { f.advance(ms); return this.value })
    expect(call.call(receiver, 'short', 249)).toBe(42)
    expect(f.lines).toEqual([])
    call.call(receiver, 'prefix/' + 'a'.repeat(48), 300)
    expect(f.lines).toEqual(['[stall] 300ms fs.openSync ' + 'a'.repeat(48)])
  })
  it('summarizes only totals >=500ms, identifies the file, and keeps run summary-only', () => {
    const f = fixture()
    f.timing.wrap('sqlite.run', () => f.advance(300), false)()
    f.timing.wrap('sqlite.run', () => f.advance(300), false)()
    f.timing.wrap('small', () => f.advance(499), false)()
    expect(f.lines).toEqual([])
    f.timing.summary('test/example.test.ts')
    expect(f.lines).toEqual(['[stall-sum] test/example.test.ts sqlite.run n=2 sum=600 max=300'])
  })
  it('rethrows the identical error and counts failed calls', () => {
    const f = fixture(), error = new Error('same object')
    const call = f.timing.wrap('fs.renameSync', () => { f.advance(500); throw error })
    expect(call).toThrow(error)
    try { call() } catch (caught) { expect(caught).toBe(error) }
    f.timing.summary('throws.test.ts')
    expect(f.lines.at(-1)).toBe('[stall-sum] throws.test.ts fs.renameSync n=2 sum=1000 max=500')
  })
  it('does no clock or logging work when disabled', () => {
    const now = vi.fn(), write = vi.fn()
    const timing = createStallTiming({ enabled: false, now, write })
    const fn = vi.fn(() => 7)
    expect(timing.wrap('fs.openSync', fn)()).toBe(7)
    timing.summary('inert.test.ts')
    expect(now).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})

it('installs around SQLite, keeps constructor semantics, builtin imports and later fs spies working', () => {
  const require = createRequire(import.meta.url)
  const Original = require('better-sqlite3')
  const probe = new Original(':memory:')
  const statementPrototype = Object.getPrototypeOf(probe.prepare('SELECT 1'))
  probe.close()
  let time = 0
  const lines: string[] = []
  const timing = installStallTiming({
    enabled: true, fs, Database: Original, statementPrototype,
    replaceDatabase: replacement => { require.cache[require.resolve('better-sqlite3')]!.exports = replacement },
    syncBuiltinESMExports, now: () => { time += 600; return time }, write: line => lines.push(line),
  })
  let db: ReturnType<typeof Original> | undefined
  try {
    const Database = require('better-sqlite3')
    expect(Database).not.toBe(Original)
    expect(Database.SqliteError).toBe(Original.SqliteError)
    db = new Database(':memory:')
    expect(db).toBeInstanceOf(Original)
    expect(db).toBeInstanceOf(Database)
    db.pragma('synchronous = FULL')
    expect(db.pragma('synchronous', { simple: true })).toBe(0)
    expect(db.exec('CREATE TABLE t (n INTEGER)')).toBe(db)
    const statement = db.prepare('INSERT INTO t VALUES (?)')
    expect(statement.run(7).changes).toBe(1)
    expect(db.prepare('SELECT n FROM t').get()).toEqual({ n: 7 })
    expect(() => new Database(123)).toThrow(TypeError)
    const callable = Database(':memory:')
    expect(callable).toBeInstanceOf(Original)
    callable.close()
    expect(fsyncSync).toBe(fs.fsyncSync)
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {})
    fs.fsyncSync(-1)
    expect(spy).toHaveBeenCalledWith(-1)
    spy.mockRestore()
    db.close(); db = undefined
    timing.summary('installation.test.ts')
    expect(lines.some(line => line.includes('sqlite.open n=3'))).toBe(true)
    expect(lines.some(line => line.includes('sqlite.run n=1'))).toBe(true)
    expect(lines.some(line => line.startsWith('[stall]') && line.includes('sqlite.run'))).toBe(false)
    expect(lines.some(line => line.includes('sqlite.pragma'))).toBe(true)
    expect(lines.some(line => line.includes('sqlite.exec'))).toBe(true)
    expect(lines.some(line => line.includes('sqlite.close'))).toBe(true)
  } finally { db?.close(); timing.restore() }
  expect(require('better-sqlite3')).toBe(Original)
  expect(fsyncSync).toBe(fs.fsyncSync)
})
