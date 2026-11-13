// Spec 075 G7 prototype (T009): every field the plugin manifest accepts should
// have a reader that does something with it, or it is a promise the file makes
// and the app does not keep. Today eight fields are parsed and validated
// (manifest.ts) and then ignored; `capabilities` is read, but only to record
// and compare a grant (trust bookkeeping) — nothing enforces it.
//
// The subject is `PluginManifest` in src/core/plugins/types.ts, read from the
// file so that a field added there must be classified here. A reader is a
// non-comment line in src/ that reads `manifest.<field>` (`p.manifest.x`,
// `plugin.manifest.x`, `manifest?.x`), outside types.ts. manifest.ts parses
// the file through the alias `m`, so its parsing is not a read; its
// `manifest.<field>` lines (the content hash) are.
//
// UNREAD is the allowlist of fields with no reader, and it only shrinks: when
// a field gains a reader the test says so and the field comes off the list
// in that change. A field NOT on the list must have a reader, and that reader
// must name the symbol. Spec 075 Phase 7-8 empties the list by giving each
// field a reader or deleting the field (FR-070s); G7 then becomes "every
// field has a registered reader".
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')
const TYPES = 'src/core/plugins/types.ts'

/** Fields nothing reads, 2026-11-13 on origin/main 984a73a2. */
const UNREAD = new Set(['homepage', 'schemaVersion', 'kind', 'emits', 'health', 'signature', 'publisher'])

/** Read, but only to record or compare a grant. Any reader outside these
 *  files would be the first one that ACTS on a capability: that is a design
 *  decision (Spec 075 FR-07x), not a drift, so it fails here until chosen. */
const BOOKKEEPING_ONLY: Record<string, string[]> = {
  capabilities: [
    'src/core/plugins/index.ts',   // grant(): records what was approved
    'src/core/plugins/loader.ts',  // isTrusted(): compares request with grant
    'src/core/plugins/manifest.ts', // content hash covers the request
    'src/main/ipc/plugins.ts'      // lists it and audits grant/revoke
  ]
}

function manifestFields(): string[] {
  const src = fs.readFileSync(path.join(ROOT, TYPES), 'utf8')
  const start = src.indexOf('export interface PluginManifest {')
  expect(start, 'PluginManifest moved or was renamed').toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1])
}

function readers(field: string): string[] {
  const re = new RegExp(`\\bmanifest\\??\\.${field}\\b`)
  const files: string[] = []
  for (const file of glob.sync('src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    if (rel === TYPES) continue
    const hit = fs.readFileSync(file, 'utf8').split(/\r?\n/).some((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) && re.test(line)
    })
    if (hit) files.push(rel)
  }
  return files.sort()
}

describe('G7 prototype: who reads each plugin manifest field (Spec 075)', () => {
  const fields = manifestFields()

  it('the schema is the one this test was written against', () => {
    expect(fields).toEqual([
      'id', 'name', 'version', 'description', 'author', 'homepage', 'redlogApi', 'schemaVersion',
      'kind', 'emits', 'health', 'contributes', 'capabilities', 'signature', 'publisher'
    ])
  })

  it('every unread field is still unread; one that gained a reader leaves the list', () => {
    const nowRead = [...UNREAD].filter((f) => readers(f).length > 0).map((f) => `${f}: ${readers(f).join(', ')}`)
    expect(nowRead, 'has a reader now: remove it from UNREAD').toEqual([])
    const gone = [...UNREAD].filter((f) => !fields.includes(f))
    expect(gone, 'no longer in PluginManifest: remove it from UNREAD').toEqual([])
  })

  it('every other field has a reader', () => {
    const none = fields.filter((f) => !UNREAD.has(f) && readers(f).length === 0)
    expect(none, 'a field with no reader: add it to UNREAD (and say why in the PR) or give it one').toEqual([])
  })

  it('capabilities is read only by trust bookkeeping', () => {
    for (const [field, allowed] of Object.entries(BOOKKEEPING_ONLY)) {
      const extra = readers(field).filter((f) => !allowed.includes(f))
      expect(extra, `${field}: a reader outside the grant bookkeeping files`).toEqual([])
      const missing = allowed.filter((f) => !readers(field).includes(f))
      expect(missing, `${field}: no longer read here, shorten BOOKKEEPING_ONLY`).toEqual([])
    }
  })

  it('manifest.ts still parses every unread field, so a field is accepted and then dropped', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/plugins/manifest.ts'), 'utf8')
    for (const f of UNREAD) expect(src, `${f} is no longer parsed`).toMatch(new RegExp(`\\b${f}\\b`))
  })
})
