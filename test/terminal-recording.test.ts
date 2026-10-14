import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalRecording } from '../src/main/terminal-recording'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function file(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cast-')); dirs.push(dir); return path.join(dir, 'session.cast') }

describe('closed terminal recording bytes', () => {
  it('hashes every committed byte immediately at close, including the final UTF-8 frame', () => {
    const target = file()
    const writer = new TerminalRecording(target, { version: 2, width: 80, height: 24 }, 5000)
    writer.append([0.1, 'o', 'first\r\n'])
    writer.append([0.2, 'o', '最後一筆\r\n'])
    const closed = writer.close()
    const bytes = fs.readFileSync(target)
    expect(closed).toMatchObject({ bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), truncated: false })
    expect(bytes.toString()).toContain('最後一筆')
    expect(writer.close()).toEqual(closed)
    expect(writer.append([0.3, 'o', 'after close'])).toBe(false)
    expect(fs.readFileSync(target)).toEqual(bytes)
  })

  it('ends a capped recording explicitly and lets a new recording have its own budget', () => {
    const a = new TerminalRecording(file(), { version: 2 }, 100)
    expect(a.append([0, 'o', 'a'.repeat(200)])).toBe(false)
    expect(a.close().truncated).toBe(true)
    const b = new TerminalRecording(file(), { version: 2 }, 100)
    expect(b.append([0, 'o', 'new'])).toBe(true)
    expect(b.close().truncated).toBe(false)
  })

  it('does not claim a successful recording hash after a partial disk write failure', () => {
    const writer = new TerminalRecording(file(), { version: 2 }, 5000)
    const original = fs.writeSync
    let calls = 0
    vi.spyOn(fs, 'writeSync').mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      if (++calls === 1) return original(args[0], args[1] as Buffer, args[2] as number, 3)
      throw new Error('disk full')
    }) as typeof fs.writeSync)
    expect(writer.append([0, 'o', 'cannot finish'])).toBe(false)
    expect(writer.close()).toMatchObject({ sha256: null, error: 'disk full' })
  })
})
