// Spec 068 FR-012/FR-013: the picker's scope query is read-only and one broken
// project cannot spoil the others.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeProjectScopes, type ProjectMeta } from '../src/core/project-manager'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-summaries-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const project = (id: string, config?: string): ProjectMeta => {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.yaml'), config)
  return { id, name: id, createdAt: 1, lastOpened: 2, path: dir }
}

const snapshot = (dir: string) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .map(e => path.join(e.parentPath, e.name))
  .sort()
  .map(f => fs.statSync(f).isFile() ? `${f}:${fs.statSync(f).mtimeMs}:${fs.readFileSync(f, 'utf-8')}` : f)

describe('summarizeProjectScopes', () => {
  it('answers per project id', () => {
    const a = project('a', 'scope:\n  targets: [10.0.0.1]\n')
    const b = project('b')
    const c = project('c', 'scope: [broken')
    expect(summarizeProjectScopes([a, b, c])).toEqual({
      a: { state: 'set', count: 1 },
      b: { state: 'unset' },
      c: { state: 'unknown' }
    })
  })

  it('one project that throws is unknown for that id only', () => {
    const a = project('a', 'scope:\n  targets: [10.0.0.1]\n')
    const b = project('b', 'scope:\n  targets: [10.0.0.2, 10.0.0.3]\n')
    const read = (dir: string) => {
      if (dir === a.path) throw new Error('EIO')
      return { state: 'set', count: 2 } as const
    }
    expect(summarizeProjectScopes([a, b], read)).toEqual({ a: { state: 'unknown' }, b: { state: 'set', count: 2 } })
  })

  it('writes nothing: files, mtimes and the entries it was given are unchanged', () => {
    const a = project('a', 'scope:\n  targets: [10.0.0.1]\n')
    const b = project('b', 'scope: [broken')
    const entries = [a, b]
    const before = { files: snapshot(root), entries: JSON.stringify(entries) }
    summarizeProjectScopes(entries)
    expect({ files: snapshot(root), entries: JSON.stringify(entries) }).toEqual(before)
  })
})
