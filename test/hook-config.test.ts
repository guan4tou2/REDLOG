import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readHookConfig, saveHookConfig } from '../src/main/services/hook-config'

describe('hook-config.json', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hookcfg-'))
    file = path.join(dir, 'hook-config.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  // Settings edits watchPaths only; excludedPaths has no UI and keeps the
  // tailer out of unrelated folders. Saving one list must not clear the other.
  it('keeps excludedPaths when a save names only watchPaths', () => {
    fs.writeFileSync(file, JSON.stringify({ excludedPaths: ['/home/op/private'], watchPaths: [] }))
    saveHookConfig({ watchPaths: ['/work/engagement'] }, file)
    expect(readHookConfig(file)).toEqual({ excludedPaths: ['/home/op/private'], watchPaths: ['/work/engagement'] })
  })

  it('clears a list the save names as empty', () => {
    fs.writeFileSync(file, JSON.stringify({ excludedPaths: ['/a'], watchPaths: ['/b'] }))
    saveHookConfig({ excludedPaths: [] }, file)
    expect(readHookConfig(file)).toEqual({ excludedPaths: [], watchPaths: ['/b'] })
  })

  it('reads a missing file as no gates', () => {
    expect(readHookConfig(file)).toEqual({ excludedPaths: [], watchPaths: [] })
  })
})
