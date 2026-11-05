// Spec 069 FR-001..FR-004: how RedLog words what it sees at the scope boundary.
// RedLog records; it does not judge or enforce. A target outside the declared
// scope is an observation against the CURRENT scope setting, not a "violation"
// that was "confirmed", and nothing here "freezes" or "blocks" a connection.
//
// The persisted values (`scope_violation`, `warnOnViolation`) are not words the
// operator reads and are deliberately NOT covered: they sit inside hashed event
// data and config.yaml (Spec 069 D1).

import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { classifyScope } from '../src/core/scope-evaluator'

const load = (loc: 'en' | 'zh-TW'): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../src/renderer/src/i18n', `${loc}.json`), 'utf-8'))

const offenders = (loc: 'en' | 'zh-TW', re: RegExp): string[] =>
  Object.entries(load(loc)).filter(([, v]) => re.test(v)).map(([k, v]) => `${loc} ${k}: ${v.slice(0, 70)}`)

describe('scope boundary copy', () => {
  it('does not call an out-of-scope observation a violation', () => {
    expect([...offenders('en', /violation/i), ...offenders('zh-TW', /違規|越界/)]).toEqual([])
  })

  it('does not claim RedLog froze, blocked or confirmed anything at the boundary', () => {
    expect([...offenders('en', /\bfroze|\bfreez|frozen/i), ...offenders('zh-TW', /凍結/)]).toEqual([])
  })

  it('does not claim to show reasoning RedLog never captured', () => {
    // `thinking` blocks are real captured transcript content and stay; a
    // "chain of thought" is a claim about the model's internals.
    expect([...offenders('en', /chain.of.thought/i), ...offenders('zh-TW', /推理鏈|思維鏈/)]).toEqual([])
  })

  it('does not infer a vulnerability or a report from a screenshot', () => {
    expect([...offenders('en', /screenshot.*(vulnerab|finding added to the report)/i), ...offenders('zh-TW', /截圖.*(漏洞|已納入報告)/)]).toEqual([])
  })
})

describe('an undeclared scope marks nothing out of scope (FR-002)', () => {
  it('with no targets and no exclusions every subject is "no-scope", never out-of-scope', () => {
    for (const subject of ['10.0.0.1', 'app.example.com', '192.168.1.50:445']) {
      expect(classifyScope(subject, { targets: [], excludeTargets: [] } as never)).toMatchObject({ status: 'no-scope', distance: 'in_scope' })
    }
  })
})
