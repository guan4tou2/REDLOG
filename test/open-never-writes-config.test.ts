// Spec 073 T007 (US2; FR-008, FR-015): opening a project does not write its
// config.yaml.
//
// "Opening" here is `prepareOpenConfig(projectDir)`, the one call
// `startProject` makes on the file (src/main/index.ts), because startProject
// itself is the Electron entry point and cannot be imported. The test that
// startProject calls it, before it closes anything, is in
// config-invalid-file.test.ts.
//
// Today `prepareOpenConfig` loads the file, merges the defaults into it and
// writes the whole thing back, so the file an operator edited by hand (and the
// file another tool wrote) is rewritten at every open, and a file that was
// already complete is replaced anyway (new mtime). The `it.fails` cases state
// the correct behaviour; each flips to a plain `it` in the phase that stops
// the open writing (Spec 073 Phase 4).
//
// The task text for T007(b) says an open of a YAML-broken project overwrites
// the file with defaults. It does not, today: that was fixed before this spec
// (config-invalid-file.test.ts). (b) is therefore a plain pin of the refusal,
// which must keep passing, and the case that is still red under FR-015 is a
// parseable file with a wrong-typed section (`network: null`), held below as an
// `it.fails`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigInvalidError, DEFAULT_CONFIG, prepareOpenConfig, saveConfig } from '../src/core/config'

let dir: string
const file = (): string => path.join(dir, 'config.yaml')
const PAST = new Date('2020-01-02T03:04:05.000Z')

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-open-writes-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function place(text: string): { bytes: Buffer; mtimeMs: number } {
  fs.writeFileSync(file(), text)
  fs.utimesSync(file(), PAST, PAST)
  return { bytes: fs.readFileSync(file()), mtimeMs: fs.statSync(file()).mtimeMs }
}

/** A hand-edited file: valid, but it names only some sections. */
const HAND_EDITED = 'engagement:\n  id: eng-1\noperator:\n  id: op-1\n  name: Ana\nscope:\n  targets:\n    - in.test\n'

describe('opening a project and its config.yaml (Spec 073 T007)', () => {
  // RED today: the open writes the merged config back, so the hand-edited file grows every section.
  it.fails('(a) a valid project\'s config.yaml is byte for byte the same after open', () => {
    const before = place(HAND_EDITED)
    prepareOpenConfig(dir)
    expect(fs.readFileSync(file())).toEqual(before.bytes)
  })

  // RED today: even a file that already carries every section is replaced (same bytes, new mtime).
  it.fails('(a) a complete config.yaml keeps its modification time across an open', () => {
    const complete = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-open-writes-src-'))
    try { saveConfig(complete, structuredClone(DEFAULT_CONFIG)); fs.copyFileSync(path.join(complete, 'config.yaml'), file()) } finally { fs.rmSync(complete, { recursive: true, force: true }) }
    fs.utimesSync(file(), PAST, PAST)
    const before = fs.readFileSync(file())
    prepareOpenConfig(dir)
    expect(fs.readFileSync(file()), 'bytes are expected to be the same today; the red is the mtime').toEqual(before)
    expect(fs.statSync(file()).mtimeMs).toBe(PAST.getTime())
  })

  // Passes today, by design of an earlier change; must keep passing.
  it('(b) a YAML-broken config.yaml is refused and left byte for byte, not overwritten with defaults', () => {
    const before = place('engagement:\n  id: eng-1\noperator:\n  id: [op-1\n')
    expect(() => prepareOpenConfig(dir)).toThrow(ConfigInvalidError)
    expect(fs.readFileSync(file())).toEqual(before.bytes)
    expect(fs.statSync(file()).mtimeMs).toBe(before.mtimeMs)
  })

  // RED today (FR-015): a parseable file with a section of the wrong type is not refused;
  // `network: null` merges in as null and the open writes it back.
  it.fails('(b) a parseable config.yaml with a wrong-typed section (`network: null`) is refused at open, untouched', () => {
    const before = place('engagement:\n  id: eng-1\nnetwork: null\n')
    expect(() => prepareOpenConfig(dir)).toThrow(ConfigInvalidError)
    expect(fs.readFileSync(file())).toEqual(before.bytes)
  })
})
