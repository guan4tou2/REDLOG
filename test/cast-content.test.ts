import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { describeEventContent, prepareEventContent, readEventContent, findEventContent } from '../src/core/evidence-content'
import { saveEventContent } from '../src/core/saved-content-delivery'
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cast-content-test-')); initDB(dir); fs.mkdirSync(path.join(dir, 'casts')) })
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })
function event(io: object) {
  getDB().prepare("INSERT INTO events(id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,hash,created_at) VALUES ('e',1,'p','s','o','shell','command_end','h',?,'original-hash',1)").run(JSON.stringify({ io }))
}
function output() {
  const reply = describeEventContent('p', 'e')
  if (!reply.ok) throw Error(reply.message)
  return reply.value.find(field => field.field === 'stdout')!
}
it('reads, finds and saves 2 MB of captured terminal output without rewriting evidence', async () => {
  const text = 'ABCDEFGHIJ'.repeat(200000) + '\r\n終端 NEEDLE'
  const cast = JSON.stringify([0, 'o', text]) + '\n'
  fs.writeFileSync(path.join(dir, 'casts', 'a.cast'), cast)
  event({ stream: 'cast', ref: 'casts/a.cast', off: 0, len: Buffer.byteLength(cast) })
  expect(await prepareEventContent('p', 'e')).toMatchObject({ ok: true })
  const field = output()
  expect(field).toMatchObject({ status: 'available', bytes: Buffer.byteLength(text), storage: 'terminal-cast' })
  expect(readEventContent({ ref: field.ref!, limit: 64 })).toMatchObject({ ok: true, value: { total: Buffer.byteLength(text), hasMore: true } })
  const hit = findEventContent({ ref: field.ref!, needle: 'NEEDLE', cursor: undefined })
  expect(hit).toMatchObject({ ok: true, value: { match: null, hasMore: true } })
  if (!hit.ok) throw Error(hit.message)
  expect(findEventContent({ ref: field.ref!, needle: 'NEEDLE', cursor: hit.value.nextCursor! })).toMatchObject({ ok: true, value: { match: { offset: Buffer.byteLength(text) - 6 } } })
  const destination = path.join(os.tmpdir(), path.basename(dir) + '.txt')
  try {
    expect(await saveEventContent(field.ref!, destination, () => true)).toMatchObject({ ok: true })
    expect(fs.readFileSync(destination, 'utf8')).toBe(text)
  } finally { fs.rmSync(destination, { force: true }) }
  expect(getDB().prepare("SELECT hash FROM events WHERE id='e'").get()).toEqual({ hash: 'original-hash' })
})
it('combines rotated parts and invalidates a cursor after the source changes', async () => {
  const first = JSON.stringify([0, 'o', 'hello ']) + '\n'
  const second = JSON.stringify({ version: 2 }) + '\n' + JSON.stringify([1, 'o', '世界']) + '\n'
  fs.writeFileSync(path.join(dir, 'casts/a.cast'), first)
  fs.writeFileSync(path.join(dir, 'casts/a.part000002.cast'), second)
  event({ stream: 'cast', ref: 'casts/a.cast', off: 0, len: Buffer.byteLength(first + second), truncated: true })
  await prepareEventContent('p', 'e')
  const field = output()
  expect(field.capture).toBe('partial')
  expect(readEventContent({ ref: field.ref! })).toMatchObject({ ok: true, value: { text: 'hello 世界' } })
  fs.writeFileSync(path.join(dir, 'casts/a.cast'), first.replace('hello', 'HELLO'))
  expect(readEventContent({ ref: field.ref! })).toMatchObject({ ok: false, status: 'changed' })
  await prepareEventContent('p', 'e')
  expect(readEventContent({ ref: field.ref! })).toMatchObject({ ok: false, status: 'changed' })
})
it('rejects missing files, incomplete ranges and paths outside the cast folder', async () => {
  event({ stream: 'cast', ref: '../outside.cast', off: 0, len: 1 })
  expect(await prepareEventContent('p', 'e')).toMatchObject({ ok: false, status: 'denied' })
  expect(await prepareEventContent('other', 'e')).toMatchObject({ ok: false, status: 'denied' })
})
it.each(['missing', 'short', 'symlink', 'malformed'] as const)('reports %s cast content without treating it as empty', async mode => {
  const file = path.join(dir, 'casts/a.cast')
  const data = JSON.stringify([0, 'o', 'text']) + '\n'
  if (mode === 'symlink') {
    fs.writeFileSync(path.join(dir, 'outside.cast'), data)
    fs.symlinkSync(path.join(dir, 'outside.cast'), file)
  } else if (mode !== 'missing') fs.writeFileSync(file, mode === 'malformed' ? '{broken}\n' : data)
  event({ stream: 'cast', ref: 'casts/a.cast', off: 0, len: mode === 'short' ? 100000 : Buffer.byteLength(mode === 'malformed' ? '{broken}\n' : data) })
  expect(await prepareEventContent('p', 'e')).toMatchObject({ ok: false })
})
it('keeps ANSI bytes and handles a window beginning inside a UTF-8 codepoint', async () => {
  const text = '\u001b[31m紅色\u001b[0m'
  const data = JSON.stringify([0, 'o', text]) + '\n'
  fs.writeFileSync(path.join(dir, 'casts/a.cast'), data)
  event({ stream: 'cast', ref: 'casts/a.cast', off: 0, len: Buffer.byteLength(data) })
  await prepareEventContent('p', 'e')
  expect(readEventContent({ ref: output().ref!, offset: 6, limit: 4 })).toMatchObject({ ok: true, value: { text: '紅', offset: 5 } })
})
