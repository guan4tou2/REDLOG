import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { completeLinePrefix, exportAttachmentDigest, withFrozenSizes, type ExportAttachment } from '../src/core/export-attachments'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const put = (name: string, text: string): string => { const f = path.join(dir, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const row = (id: string, frozenBytes?: number): ExportAttachment => ({
  id, kind: 'cast', bytes: frozenBytes ?? null, targets: [], attribution: 'unattributed', status: 'included',
  ...(frozenBytes === undefined ? {} : { frozenBytes })
})

describe('completeLinePrefix', () => {
  it('stops at the last newline, leaving a half-written line out', () => {
    const f = put('a.cast', 'head\nline1\nhal')
    expect(completeLinePrefix(f, fs.statSync(f).size)).toBe('head\nline1\n'.length)
  })
  it('takes the whole file when it already ends on a newline', () => {
    const f = put('b.cast', 'head\nline1\n')
    expect(completeLinePrefix(f, 11)).toBe(11)
  })
  it('finds a newline that is more than one read-buffer back', () => {
    const f = put('c.cast', 'head\n' + 'x'.repeat(200_000))
    expect(completeLinePrefix(f, fs.statSync(f).size)).toBe(5)
  })
  it('freezes a file with no newline whole, and an empty one at 0', () => {
    expect(completeLinePrefix(put('d.cast', 'no newline here'), 15)).toBe(15)
    expect(completeLinePrefix(put('e.cast', ''), 0)).toBe(0)
  })
})

describe('attachment digest over a frozen prefix', () => {
  it('does not change when the file only grows past the prefix', () => {
    const f = put('casts/g.cast', 'head\nl1\n')
    const before = exportAttachmentDigest(dir, [row('casts/g.cast', 8)])
    fs.appendFileSync(f, 'l2\nl3\n')
    expect(exportAttachmentDigest(dir, [row('casts/g.cast', 8)])).toBe(before)
  })
  it('changes when the prefix is rewritten or the file is cut shorter', () => {
    const f = put('casts/h.cast', 'head\nl1\n')
    const before = exportAttachmentDigest(dir, [row('casts/h.cast', 8)])
    fs.writeFileSync(f, 'head\nL1\nmore\n')
    expect(exportAttachmentDigest(dir, [row('casts/h.cast', 8)])).not.toBe(before)
    fs.writeFileSync(f, 'head\n')
    expect(exportAttachmentDigest(dir, [row('casts/h.cast', 8)])).not.toBe(before)
  })
  it('hashes a row with no frozen size over the whole file, as before', () => {
    const f = put('casts/i.cast', 'head\nl1\n')
    const before = exportAttachmentDigest(dir, [row('casts/i.cast')])
    fs.appendFileSync(f, 'l2\n')
    expect(exportAttachmentDigest(dir, [row('casts/i.cast')])).not.toBe(before)
  })
  it('withFrozenSizes puts the approved sizes onto a fresh listing and drops stale ones', () => {
    const fresh = [row('casts/a.cast', 99), row('casts/b.cast', 50)]
    const out = withFrozenSizes(fresh, [row('casts/a.cast', 10)])
    expect(out.find((a) => a.id === 'casts/a.cast')?.frozenBytes).toBe(10)
    expect(out.find((a) => a.id === 'casts/b.cast')?.frozenBytes).toBeUndefined()
  })
})
