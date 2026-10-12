import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { clearUnattributedSpool, summarizeUnattributedSpool } from '../src/core/spool-replay'

// #255, the other half of showing the count: the operator has looked and wants
// the files gone.

describe('clearUnattributedSpool', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-spool-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const T = Date.UTC(2026, 9, 12, 2, 0, 0)
  const write = (name: string, mtime: number): void => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, '{}')
    fs.utimesSync(file, mtime / 1000, mtime / 1000)
  }
  const left = (): string[] => fs.readdirSync(dir).sort()

  it('deletes the set-aside files and nothing else', () => {
    write('a.json.unattributed', T)
    write('b.json.unattributed', T + 1000)
    write('c.json', T)          // still waiting for replay
    write('d.json.bad', T)      // somebody may want to look at it
    expect(clearUnattributedSpool(dir, T + 1000)).toEqual({ removed: 2, failed: 0 })
    expect(left()).toEqual(['c.json', 'd.json.bad'])
    expect(summarizeUnattributedSpool(dir)).toBeNull()
  })

  it('leaves what was set aside after the operator was shown the count', () => {
    // The card said "newest: T". One more arrived at T+5s before the click;
    // deleting it would be deleting a file nobody saw counted.
    write('seen.json.unattributed', T)
    write('later.json.unattributed', T + 5000)
    expect(clearUnattributedSpool(dir, T)).toEqual({ removed: 1, failed: 0 })
    expect(left()).toEqual(['later.json.unattributed'])
    expect(summarizeUnattributedSpool(dir)).toMatchObject({ count: 1, newestAt: T + 5000 })
  })

  it('counts what it could not delete, and leaves it counted', () => {
    // A directory with the right name cannot be unlinked as a file on any
    // platform: it stands in for a file that is open elsewhere.
    write('ok.json.unattributed', T)
    fs.mkdirSync(path.join(dir, 'stuck.json.unattributed'))
    expect(clearUnattributedSpool(dir, Date.now() + 60_000)).toEqual({ removed: 1, failed: 1 })
    expect(left()).toEqual(['stuck.json.unattributed'])
    expect(summarizeUnattributedSpool(dir)).toMatchObject({ count: 1 })
  })

  it('does nothing for a directory that is not there', () => {
    expect(clearUnattributedSpool(path.join(dir, 'missing'), Date.now())).toEqual({ removed: 0, failed: 0 })
  })
})
