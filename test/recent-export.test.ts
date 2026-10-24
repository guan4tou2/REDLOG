import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RecentExportStore } from '../src/main/services/recent-export'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-recent-export-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })
const receipt = (artifactPath: string) => ({ artifactPath, format: 'json' as const, completedAt: 1_700_000_000_000 })

it('persists only one completed artifact per project/root on this machine', () => {
  const storeDir = path.join(dir, 'machine-data')
  const file = path.join(dir, 'evidence.json'); fs.writeFileSync(file, '{}')
  new RecentExportStore(storeDir).remember('p', dir, receipt(file))
  const reopened = new RecentExportStore(storeDir)
  expect(reopened.get('p', dir)).toEqual({ ...receipt(file), availability: 'available' })
  expect(reopened.get('other', dir)).toBeNull()
  expect(reopened.get('p', path.join(dir, 'copied-project'))).toBeNull()
  const next = path.join(dir, 'next.json'); fs.writeFileSync(next, '{}')
  reopened.remember('p', dir, receipt(next))
  expect(fs.readdirSync(storeDir)).toHaveLength(1)
  expect(reopened.get('p', dir)?.artifactPath).toBe(next)
  if (process.platform !== 'win32') expect(fs.statSync(path.join(storeDir, fs.readdirSync(storeDir)[0])).mode & 0o777).toBe(0o600)
})

it('distinguishes a removed artifact and unreadable/corrupt metadata from no prior export', () => {
  const storeDir = path.join(dir, 'machine-data'), file = path.join(dir, 'evidence.json')
  const store = new RecentExportStore(storeDir)
  expect(store.get('p', dir)).toBeNull()
  fs.writeFileSync(file, '{}'); store.remember('p', dir, receipt(file)); fs.unlinkSync(file)
  expect(store.get('p', dir)?.availability).toBe('missing')
  fs.writeFileSync(path.join(storeDir, fs.readdirSync(storeDir)[0]), '{incomplete')
  expect(() => store.get('p', dir)).toThrow('recent-export-unreadable')
})

it('keeps the earlier receipt if atomic replacement fails', () => {
  const storeDir = path.join(dir, 'machine-data'), file = path.join(dir, 'first.json')
  fs.writeFileSync(file, '{}')
  const store = new RecentExportStore(storeDir); store.remember('p', dir, receipt(file))
  const fail = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected write refusal') })
  expect(() => store.remember('p', dir, receipt(path.join(dir, 'second.json')))).toThrow('injected write refusal')
  expect(fail).toHaveBeenCalledOnce(); fail.mockRestore()
  expect(store.get('p', dir)?.artifactPath).toBe(file)
  expect(fs.readdirSync(storeDir)).toHaveLength(1)
})

it.each(['null', 'false', '{}', '[]'])('rejects valid JSON with an invalid receipt shape: %s', contents => {
  const storeDir = path.join(dir, 'machine-data'), file = path.join(dir, 'artifact.json')
  const store = new RecentExportStore(storeDir)
  store.remember('p', dir, receipt(file))
  fs.writeFileSync(path.join(storeDir, fs.readdirSync(storeDir)[0]), contents)
  expect(() => store.get('p', dir)).toThrow('recent-export-invalid')
})
