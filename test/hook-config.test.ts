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

  // A no-op save must not erase local exclusions.
  it('keeps excludedPaths when a save omits them', () => {
    fs.writeFileSync(file, JSON.stringify({ excludedPaths: ['/home/op/private'] }))
    saveHookConfig({}, file)
    expect(readHookConfig(file)).toEqual({ excludedPaths: ['/home/op/private'] })
  })

  it('clears a list the save names as empty', () => {
    fs.writeFileSync(file, JSON.stringify({ excludedPaths: ['/a'] }))
    saveHookConfig({ excludedPaths: [] }, file)
    expect(readHookConfig(file)).toEqual({ excludedPaths: [] })
  })

  it('reads a missing file as no gates', () => {
    expect(readHookConfig(file)).toEqual({ excludedPaths: [] })
  })
})
