// Evidence bytes do not depend on the machine's locale.
//
// `localeCompare` with no locale collates by the process's ICU default. Where
// its order reaches what an export or a chained row says — the attachment
// digest in manifest.exportPlan.fingerprint, manifest.attachments.casts[], a
// file-watcher row's related_commands inside the hash — the same project
// produced different bytes on a Danish machine (`aa` sorts after `z`, so a
// lowercase-hex UUID moves) and on any machine for mixed-case or punctuated
// names. Those orders are code-unit order now (src/core/code-unit-order.ts).
//
// The inputs below are shown to be locale-sensitive in the test itself — the
// Danish and English collators order them otherwise — so the assertions hold
// whatever locale the machine running them has.
//
// Then a ratchet: no locale-dependent string API in src/core or src/main, the
// processes that write evidence.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import glob from 'fast-glob'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareCodeUnits } from '../src/core/code-unit-order'
import { exportAttachmentDigest, listExportAttachments, type ExportAttachment } from '../src/core/export-attachments'
import { noteStartEvent, relatedCommandCandidates, _resetCausesResolver } from '../src/core/causes-resolver'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

// Hex UUIDs: `aa…` before `b…` in code units; after it under Danish collation.
const UUID_AA = 'aa0e8400-e29b-41d4-a716-446655440000'
const UUID_B = 'b0b0b0b0-e29b-41d4-a716-446655440000'
// Mixed case: `R` (U+0052) before `r` (U+0072) in code units; English (the
// ICU root order) puts the lowercase one first.
const UPPER = '1a2b3c4d5e6f-Report.xml'
const LOWER = '1a2b3c4d5e6f-report.xml'

const da = new Intl.Collator('da')
const en = new Intl.Collator('en')

it('the inputs are locale-sensitive: the collators order them otherwise than code units', () => {
  expect(Intl.Collator.supportedLocalesOf(['da', 'en'])).toEqual(['da', 'en'])
  expect([UUID_AA, UUID_B].sort(compareCodeUnits)).toEqual([UUID_AA, UUID_B])
  expect([UUID_AA, UUID_B].sort(da.compare)).toEqual([UUID_B, UUID_AA])
  expect([LOWER, UPPER].sort(compareCodeUnits)).toEqual([UPPER, LOWER])
  expect([UPPER, LOWER].sort(en.compare)).toEqual([LOWER, UPPER])
  expect(['ab', 'a_b', 'a-b'].sort(compareCodeUnits)).toEqual(['a-b', 'a_b', 'ab'])
  expect(['ab', 'a_b', 'a-b'].sort(en.compare)).not.toEqual(['a-b', 'a_b', 'ab'])
})

describe('export attachments', () => {
  let dir: string
  const base = { timestamp: 1, engagementId: 'e', sessionId: 's', operatorId: 'o', hostname: '', sourceIP: null, hash: null, prevHash: null, signature: null, createdAt: 1 }
  const artifact = (id: string, stored: string) =>
    ({ ...base, id, agentType: 'file_transfer', targetId: null, data: { subtype: 'artifact_added', stored } })
  const shot = (id: string, filename: string) =>
    ({ ...base, id, agentType: 'screenshot', targetId: null, data: { filename } })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-locale-'))
    for (const d of ['artifacts', 'screenshots']) fs.mkdirSync(path.join(dir, d))
    for (const name of [UPPER, LOWER]) fs.writeFileSync(path.join(dir, 'artifacts', name), name)
    for (const name of [`${UUID_AA}.jpg`, `${UUID_B}.jpg`]) fs.writeFileSync(path.join(dir, 'screenshots', name), name)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const listed = (): ExportAttachment[] => listExportAttachments(dir, [
    // Given in the order neither collator nor code units would choose.
    artifact('e2', `artifacts/${LOWER}`), artifact('e1', `artifacts/${UPPER}`),
    shot('s2', `${UUID_B}.jpg`), shot('s1', `${UUID_AA}.jpg`)
  ] as never)

  it('are listed in code-unit order (manifest.attachments order)', () => {
    const ids = listed().map((a) => a.id)
    const want = [`artifacts/${UPPER}`, `artifacts/${LOWER}`, `screenshots/${UUID_AA}.jpg`, `screenshots/${UUID_B}.jpg`]
    expect(ids).toEqual(want)
    expect([...ids].sort(da.compare)).not.toEqual(want)
    expect([...ids].sort(en.compare)).not.toEqual(want)
  })

  it('are digested in code-unit order (manifest.exportPlan.fingerprint)', () => {
    const attachments = listed()
    expect(attachments.every((a) => a.status === 'included')).toBe(true)
    const digestIn = (order: (a: string, b: string) => number): string => {
      const h = crypto.createHash('sha256')
      for (const a of [...attachments].sort((x, y) => order(x.id, y.id))) {
        const bytes = fs.readFileSync(path.join(dir, a.id))
        h.update(JSON.stringify([a.id, crypto.createHash('sha256').update(bytes).digest('hex'), bytes.length]))
      }
      return h.digest('hex')
    }
    // Shuffled input: the digest does not follow the order it was given in.
    const got = exportAttachmentDigest(dir, [...attachments].reverse())
    expect(got).toBe(digestIn(compareCodeUnits))
    expect(got).not.toBe(digestIn(da.compare))
    expect(got).not.toBe(digestIn(en.compare))
  })
})

describe('related_commands of a file-watcher row', () => {
  beforeEach(() => _resetCausesResolver())

  it('ties on cwd length are broken by event id in code-unit order', () => {
    const cwd = path.resolve('/work')
    noteStartEvent('shell', { subtype: 'command_start', terminalId: 't1', pid: 1, command: 'one', cwd }, UUID_B)
    noteStartEvent('shell', { subtype: 'command_start', terminalId: 't2', pid: 2, command: 'two', cwd }, UUID_AA)
    const ids = relatedCommandCandidates({ subtype: 'file_created', source: 'file-watcher', path: path.join(cwd, 'out.xml') })
      .map((c) => c.event_id)
    expect(ids).toEqual([UUID_AA, UUID_B])
    expect([...ids].sort(da.compare)).toEqual([UUID_B, UUID_AA])
  })

  it('so are ids that differ only in case, which every locale reorders', () => {
    const cwd = path.resolve('/work')
    const lower = 'evt-report', upper = 'evt-Report'
    noteStartEvent('shell', { subtype: 'command_start', terminalId: 't1', pid: 1, command: 'one', cwd }, lower)
    noteStartEvent('shell', { subtype: 'command_start', terminalId: 't2', pid: 2, command: 'two', cwd }, upper)
    const ids = relatedCommandCandidates({ subtype: 'file_created', source: 'file-watcher', path: path.join(cwd, 'out.xml') })
      .map((c) => c.event_id)
    expect(ids).toEqual([upper, lower])
    expect([...ids].sort(en.compare)).toEqual([lower, upper])
  })
})

// ── Ratchet ──────────────────────────────────────────────────────────────────
// src/core and src/main write evidence: rows, exports, manifests. A string API
// whose result depends on the process locale does not belong there. Display
// formatting belongs in the renderer. Anything that must stay here is listed
// with the reason it never reaches evidence bytes, and the test fails when an
// allowed use is gone so the list does not go stale.
const LOCALE_DEPENDENT = /\.localeCompare\s*\(|\bIntl\s*\.\s*[A-Z]\w*|\.toLocale(?:Lower|Upper)Case\s*\(|\.toLocale(?:Date|Time)?String\s*\(/g
const ALLOWED: ReadonlyMap<string, string> = new Map<string, string>([
  // 'src/main/example.ts': 'why it is display-only'
])

it('no locale-dependent string API in src/core or src/main', () => {
  const found = new Map<string, string[]>()
  for (const file of glob.sync('src/{core,main}/**/*.{ts,tsx,js,mjs,cjs}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    const hits = [...fs.readFileSync(file, 'utf8').matchAll(LOCALE_DEPENDENT)].map((m) => m[0])
    if (hits.length) found.set(rel, hits)
  }
  const unexpected = [...found].filter(([rel]) => !ALLOWED.has(rel))
  expect(unexpected, 'Use compareCodeUnits (src/core/code-unit-order.ts) for an order that reaches evidence; ' +
    'format for display in the renderer. Allow a use here only with the reason it never reaches evidence bytes.').toEqual([])
  expect([...ALLOWED.keys()].filter((rel) => !found.has(rel)), 'allowed, no longer used: remove from ALLOWED').toEqual([])
})
