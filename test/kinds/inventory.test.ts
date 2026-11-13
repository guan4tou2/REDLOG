// Spec 072 T002 — the inventory of what writers write today (test/kinds/inventory.ts).
//
// The scan itself is a helper; this file is what makes it a gate:
//
//   - the inventory is complete in the sense it can check: no TypeScript call
//     site whose subtype or agent_type it cannot read is left unanswered
//     (`unannotated`), no reviewed answer points at text that has gone
//     (`stale`), and no hook or plugin file that writes a kind is missing from
//     FILE_AGENT_TYPES (`undeclared`);
//   - the blind spots the helper's header lists each have a negative assertion,
//     so a writer that starts to use one fails here instead of vanishing;
//   - the kinds found are pinned, so a new writer shows up as a diff of this
//     list rather than as nothing. Phase 2's registry gate will compare the
//     same list with the registry in both directions.
//
// The pinned list is the one place a human reads "what can RedLog write".
// To change it: write the new kind, run this file, copy the printed list.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import glob from 'fast-glob'
import { scanInventory, kindIds, type Inventory } from './inventory'

const ROOT = path.join(__dirname, '..', '..')
let inv: Inventory
const getInventory = (): Inventory => (inv ??= scanInventory(ROOT))

// Counted 2026-11-13 on origin/main c27ed558.
const KIND_COUNT = 137

describe('the writer inventory (Spec 072 T002)', () => {
  it('leaves no TypeScript call site unanswered', () => {
    const { unannotated } = getInventory()
    expect(unannotated.map((d) => `${d.file}:${d.line} ${d.agentType ?? '?'} — ${d.reason}\n    ${d.text}`).join('\n')).toBe('')
  })

  it('has no reviewed answer whose text is gone', () => {
    expect(getInventory().stale.join('\n')).toBe('')
  })

  it('has every hook and plugin writer declared in FILE_AGENT_TYPES', () => {
    expect(getInventory().undeclared.join('\n')).toBe('')
  })

  it('finds the kinds it found when this was written, and says so when that changes', () => {
    const ids = kindIds(getInventory().hits)
    // The failure message IS the list: copy it back when a writer was added on purpose.
    expect(ids.length, ids.join('\n')).toBe(KIND_COUNT)
  })

  it('reads every agent_type of the kinds it found from something it can name', () => {
    const odd = getInventory().hits.filter((h) => !/^[a-z0-9_]+$/.test(h.agentType) || (h.subtype !== '' && !/^[a-z0-9_]+$/.test(h.subtype)))
    expect(odd.map((h) => `${h.file}:${h.line} ${h.agentType}:${h.subtype}`)).toEqual([])
  })
})

// A blind spot with no assertion is a place a writer can hide. Each of these is
// a pattern the scan cannot read; today it appears nowhere.
describe('the inventory blind spots stay empty', () => {
  const read = (pattern: string): Array<{ file: string; text: string; line: number }> => {
    const out: Array<{ file: string; text: string; line: number }> = []
    for (const abs of glob.sync(pattern, { cwd: ROOT, absolute: true })) {
      fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((text, i) => out.push({ file: path.relative(ROOT, abs).split(path.sep).join('/'), text, line: i + 1 }))
    }
    return out
  }
  const live = (l: { text: string }): boolean => { const t = l.text.trim(); return !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('*') }

  it('no shell hook calls _redlog_send_event with a subtype it builds in a variable', () => {
    const hits = [...read('hooks/*.sh'), ...read('hooks/*.zsh')]
      .filter(live).filter((l) => /_redlog_send_event\s+(?!")[^\s]/.test(l.text) && !/_redlog_send_event\(\)/.test(l.text))
    expect(hits.map((l) => `${l.file}:${l.line} ${l.text.trim()}`)).toEqual([])
  })

  it('no Python writer assembles an event with dict(**…)', () => {
    const hits = read('hooks/*.py').filter(live).filter((l) => /\bdict\(\s*\*\*/.test(l.text))
    expect(hits.map((l) => `${l.file}:${l.line} ${l.text.trim()}`)).toEqual([])
  })

  it('no plugin builds its subtype from a dynamic string', () => {
    const hits = read('plugins/**/*.js').filter(live).filter((l) => /\bsubtype\s*:\s*(?!')\S/.test(l.text))
    expect(hits.map((l) => `${l.file}:${l.line} ${l.text.trim()}`)).toEqual([])
  })

  it('the one PowerShell helper that forwards -Subtype $Subtype is the only one', () => {
    const hits = read('hooks/*.ps1').filter(live).filter((l) => /-Subtype\s+\$/.test(l.text))
    expect(hits.map((l) => `${l.file}:${l.line}`)).toEqual(['hooks/shell-hook.ps1:124'])
  })
})
