import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

// A symlink placed inside a project folder used to be followed out of it:
// probing an isolated instance read an outside canary file back through the
// screenshot protocol and the HTTP body read, and `screenshot:deleteFile`
// hashed the link's target into the chain while deleting only the link.
// Every reader below is the function behind the handler, given a project whose
// folder holds such a link.

import { initDB, closeDB } from '../src/core/db/index'
import { insertEvent, queryEvents } from '../src/core/db/events'
import { _resetIngest } from '../src/core/ingest'
import * as bodyStore from '../src/core/http-body-store'
import { resolveContainedFile } from '../src/core/contained-file'
import { screenshotRequestFile } from '../src/main/screenshot-protocol'
import { registerMarkersIpc } from '../src/main/ipc/markers'
import { registerTerminalIpc } from '../src/main/ipc/terminal'
import type { IpcContext } from '../src/main/ipc/types'

type Handler = (_e: unknown, ...args: unknown[]) => unknown

const CANARY = 'outside-canary-contents'
let root: string
let project: string
let outside: string
let handlers: Map<string, Handler>

const link = (target: string, at: string): void => { fs.symlinkSync(target, at) }

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-contain-')))
  project = path.join(root, 'project')
  outside = path.join(root, 'outside.txt')
  fs.mkdirSync(path.join(project, 'screenshots'), { recursive: true })
  fs.mkdirSync(path.join(project, 'casts'), { recursive: true })
  fs.mkdirSync(path.join(project, 'http-bodies'), { recursive: true })
  fs.writeFileSync(path.join(project, 'config.yaml'), 'engagement:\n  id: eng-1\noperator:\n  id: op-1\n')
  fs.writeFileSync(outside, CANARY)
  initDB(project)
  _resetIngest()
  bodyStore.resetBodiesDirCache()
  handlers = new Map()
  const ctx = {
    getActiveProject: () => ({ id: 'eng-1', name: 'T', path: project, createdAt: 1, lastOpened: 1 }),
    getCurrentEngagementId: () => 'eng-1',
    getCurrentOperatorId: () => 'op-1'
  } as unknown as IpcContext
  const ipc = { handle: (n: string, fn: Handler) => handlers.set(n, fn), on: () => {} } as never
  registerMarkersIpc(ipc, ctx, {} as never)
  registerTerminalIpc(ipc, ctx)
})

afterEach(() => {
  closeDB()
  bodyStore.resetBodiesDirCache()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveContainedFile', () => {
  it('returns a regular file inside the folder', () => {
    const f = path.join(project, 'screenshots', 'a.jpg')
    fs.writeFileSync(f, 'x')
    expect(resolveContainedFile(path.join(project, 'screenshots'), 'a.jpg')).toBe(f)
  })
  it('refuses a link out, a link in, a directory, a `..` walk, and a linked folder', () => {
    const dir = path.join(project, 'screenshots')
    fs.writeFileSync(path.join(dir, 'real.jpg'), 'x')
    link(outside, path.join(dir, 'out.jpg'))
    link(path.join(dir, 'real.jpg'), path.join(dir, 'in.jpg'))
    fs.mkdirSync(path.join(dir, 'sub'))
    expect(resolveContainedFile(dir, 'out.jpg')).toBeNull()
    expect(resolveContainedFile(dir, 'in.jpg')).toBeNull()
    expect(resolveContainedFile(dir, 'sub')).toBeNull()
    expect(resolveContainedFile(dir, '../config.yaml')).toBeNull()
    expect(resolveContainedFile(dir, '')).toBeNull()
    // A folder inside that is a link out: the file name is fine, the path is not.
    fs.mkdirSync(path.join(root, 'elsewhere'))
    fs.writeFileSync(path.join(root, 'elsewhere', 'b.jpg'), CANARY)
    link(path.join(root, 'elsewhere'), path.join(dir, 'via'))
    expect(resolveContainedFile(dir, 'via/b.jpg')).toBeNull()
    // The folder itself a link.
    const linkedRoot = path.join(project, 'linked-shots')
    link(path.join(root, 'elsewhere'), linkedRoot)
    expect(resolveContainedFile(linkedRoot, 'b.jpg')).toBeNull()
  })
})

describe('redlog-screenshot:// protocol', () => {
  it('serves a screenshot and refuses a link to a file outside the project', () => {
    fs.writeFileSync(path.join(project, 'screenshots', 'shot.jpg'), 'jpeg')
    link(outside, path.join(project, 'screenshots', 'canary.jpg'))
    expect(screenshotRequestFile('redlog-screenshot://local/shot.jpg', project)).toEqual({ file: path.join(project, 'screenshots', 'shot.jpg') })
    expect(screenshotRequestFile('redlog-screenshot://local/canary.jpg', project)).toEqual({ status: 404 })
    expect(screenshotRequestFile('redlog-screenshot://local/missing.jpg', project)).toEqual({ status: 404 })
    expect(screenshotRequestFile('redlog-screenshot://local/..%2F..%2Foutside.txt', project)).not.toHaveProperty('file')
    expect(screenshotRequestFile('redlog-screenshot://..', project)).toEqual({ status: 400 })
  })
})

describe('HTTP body read', () => {
  it('does not return the contents of a link planted in http-bodies/', () => {
    const name = `${'a'.repeat(64)}.body`
    link(outside, path.join(project, 'http-bodies', name))
    expect(bodyStore.readBody({ sha256: '', size: 0, file: name, encoding: 'text' })).toBeNull()
  })
  it('still reads a stored body', () => {
    const ref = bodyStore.storeBody({ data: 'hello body', encoding: 'text' } as never)
    expect(bodyStore.readBody(ref)).toBe('hello body')
  })
})

describe('casts:readRange', () => {
  it('does not read through a link in casts/', async () => {
    link(outside, path.join(project, 'casts', 'evil.cast'))
    expect(await handlers.get('casts:readRange')!({}, 'evil.cast', 0, CANARY.length)).toBeNull()
  })
  it('does not read through a linked folder in casts/', async () => {
    const away = path.join(root, 'away')
    fs.mkdirSync(away)
    fs.writeFileSync(path.join(away, 'x.cast'), `{"version":2}\n[0.1,"o","${CANARY}"]\n`)
    link(away, path.join(project, 'casts', 'sub'))
    expect(await handlers.get('casts:readRange')!({}, 'sub/x.cast', 0, 200)).toBeNull()
  })
})

describe('screenshot:deleteFile', () => {
  const shot = (filePath: string): string =>
    insertEvent('screenshot', { filePath, filename: path.basename(filePath), trigger: 'manual' }, { engagementId: 'eng-1', operatorId: 'op-1' })!.id
  const deletions = (): Array<Record<string, unknown>> =>
    queryEvents({ agentType: 'system', limit: 50 }).filter((e) => e.data.subtype === 'screenshot_deleted').map((e) => e.data)

  it('refuses a link: the target is not hashed into the chain and nothing is removed', async () => {
    const at = path.join(project, 'screenshots', 'linked.jpg')
    link(outside, at)
    const id = shot(at)
    const res = await handlers.get('screenshot:deleteFile')!({}, id, at) as { ok: boolean }
    expect(res.ok).toBe(false)
    expect(fs.lstatSync(at).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(outside, 'utf-8')).toBe(CANARY)
    expect(deletions()).toEqual([])
  })

  it('refuses an event id that is not a screenshot of this project, or names another file', async () => {
    const at = path.join(project, 'screenshots', 'real.jpg')
    fs.writeFileSync(at, 'jpeg')
    const other = path.join(project, 'screenshots', 'other.jpg')
    fs.writeFileSync(other, 'jpeg2')
    const marker = insertEvent('marker', { title: 't' }, { engagementId: 'eng-1', operatorId: 'op-1' })!.id
    const del = handlers.get('screenshot:deleteFile')!
    expect((await del({}, marker, at) as { ok: boolean }).ok).toBe(false)
    expect((await del({}, 'no-such-event', at) as { ok: boolean }).ok).toBe(false)
    expect((await del({}, shot(other), at) as { ok: boolean }).ok).toBe(false)
    expect(fs.existsSync(at)).toBe(true)
    expect(deletions()).toEqual([])
  })

  it('deletes a screenshot and chains the hash of what was deleted', async () => {
    const at = path.join(project, 'screenshots', 'real.jpg')
    fs.writeFileSync(at, 'jpeg-bytes')
    const id = shot(at)
    expect(await handlers.get('screenshot:deleteFile')!({}, id, at)).toEqual({ ok: true })
    expect(fs.existsSync(at)).toBe(false)
    expect(deletions()).toEqual([expect.objectContaining({
      source_event: id, path: 'real.jpg', sha256_pre_delete: crypto.createHash('sha256').update('jpeg-bytes').digest('hex')
    })])
  })
})
