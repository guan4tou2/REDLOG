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

  it('continues across bounded cast parts and keeps logical byte ranges readable', async () => {
    const target = file()
    const writer = new TerminalRecording(target, { version: 2, timestamp: 1700000000 }, 180)
    const first = writer.bytes
    const text = '長輸出\r\n'.repeat(100)
    expect(writer.append([0.1, 'o', text])).toBe(true)
    const closed = writer.close()
    expect(closed.truncated).toBe(false)
    expect(closed.segments.length).toBeGreaterThan(1)
    const parts = closed.segments.map(part => fs.readFileSync(part.path))
    expect(parts.every(part => part.length <= 180)).toBe(true)
    expect(closed.sha256).toBe(crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex'))
    const { readCastRange, readCastSlice } = await import('../src/core/cast-slice')
    expect((await readCastRange(target, first, closed.bytes - first))?.text).toBe(text)
    expect((await readCastSlice(target, 0, Number.MAX_SAFE_INTEGER))?.text).toBe(text)
    for (const part of closed.segments) {
      expect(part.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(part.path)).digest('hex'))
    }
  })

  it('bounds previews without hiding a later time window or losing exported parts', async () => {
    const target = file()
    const writer = new TerminalRecording(target, { version: 2, timestamp: 1700000000 }, 160)
    writer.append([0.1, 'o', 'early-'.repeat(20)])
    writer.append([4, 'o', 'late-'.repeat(20)])
    writer.close()
    const { readCastSlice } = await import('../src/core/cast-slice')
    const preview = await readCastSlice(target, 0, Number.MAX_SAFE_INTEGER, 70)
    expect(preview?.truncated).toBe(true)
    expect(preview!.bytes).toBeLessThanOrEqual(70)
    expect((await readCastSlice(target, 1700000003000, 1700000005000))?.text).toBe('late-'.repeat(20))
    fs.unlinkSync(path.join(path.dirname(target), 'session.part000002.cast'))
    expect(await readCastSlice(target, 0, Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it('keeps a real recording beyond 50 MiB with bounded parts and incremental hashes', () => {
    const target = file()
    const writer = new TerminalRecording(target, { version: 2, timestamp: 1700000000 }, 50 * 1024 * 1024)
    const block = 'x'.repeat(64 * 1024)
    for (let n = 0; n < 850; n++) expect(writer.append([n / 10, 'o', block])).toBe(true)
    const closed = writer.close()
    expect(closed.bytes).toBeGreaterThan(50 * 1024 * 1024)
    expect(closed.segments).toHaveLength(2)
    expect(closed.truncated).toBe(false)
    expect(closed.segments.every(part => part.bytes <= 50 * 1024 * 1024)).toBe(true)
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
