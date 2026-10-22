import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { repoRelative } from './helpers/repo-path'
import glob from 'fast-glob'

// AGENTS.md: "Avoid unnecessary secondary labels and descriptions. Let the
// layout do the explaining." `docs/UIUX-CONTROLS-AND-COPY.md` §2 is the test,
// and until now nothing ran it. A rule that only lives in a prompt is advice;
// the reviewer reads it and the next agent does not.
//
// This is the mechanical half of that rule — the part a machine can decide
// without taste. It deliberately does NOT try to judge whether a sentence is
// worth saying: that needs the four questions in §2 and a human. What it
// catches is the shapes that are never right, however good the intent:
//
//   1. the same explanation stored twice (copy drifts, and one copy goes stale)
//   2. a descriptive key nothing renders (dead prose in the translator's queue)
//   3. a hint that is its own label with extra words
//   4. a tooltip that only repeats the visible text beside it
//   5. a paragraph where a helper line belongs
//
// Deliberate non-rules: length alone, sentence count alone, and any ban on
// hint keys. The clipboard scope warning, the SYN-scan blind spot and the
// unsigned-build update instructions are all long, and all belong.

const ROOT = path.join(__dirname, '..')
const load = (loc: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n', `${loc}.json`), 'utf-8'))

/** Keys whose value is an explanation rather than a control label. */
const DESCRIPTIVE = /(?:^|\.)(?:[a-zA-Z0-9]*(?:Hint|hint|Desc|desc|Why|why|Note|note)|subtitle|tagline)$/

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Every source file that can render a key. */
function sources(): Array<{ file: string; text: string }> {
  return glob.sync(['src/**/*.{ts,tsx}'], { cwd: ROOT, absolute: false })
    .map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf-8') }))
}

describe('UI copy: no redundant descriptions', () => {
  // Every rule runs against BOTH locales. The English side was the first
  // implementation, and running only that side missed two real defects the
  // Chinese side had: a message that named neither of two different problems,
  // and a card label that read exactly like a violation counter. A duplicate
  // sentence is invisible in one language and obvious in another.
  const LOCALES = ['en', 'zh-TW'] as const

  it('does not store the same explanation under two keys', () => {
    const offenders: string[] = []
    for (const loc of LOCALES) {
      const dict = load(loc)
      const seen = new Map<string, string[]>()
      // Every key, not only the descriptive ones. A mutation test showed the
      // descriptive-only version passing a pair of identical explanations
      // stored as `test.dupA` / `test.dupB`: the rule's name promised more than
      // it checked. Duplicated prose is duplicated prose whatever the key is
      // called, and the cost is the same — one copy gets edited, the other goes
      // stale in a language nobody re-read.
      for (const [k, v] of Object.entries(dict)) {
        // Very short values are labels ("Cancel", "Retry") and repeat on purpose.
        if (v.length < (loc === 'zh-TW' ? 10 : 24)) continue
        const key = norm(v)
        seen.set(key, [...(seen.get(key) ?? []), k])
      }
      for (const [v, keys] of seen) {
        if (keys.length > 1) offenders.push(`${loc}: ${keys.join(' / ')} — "${v.slice(0, 70)}"`)
      }
    }
    // Two keys with the same sentence means one of them will be edited and the
    // other will not. Keep one string and reference it, or say different things.
    expect(offenders).toEqual([])
  })

  it('has no descriptive key that nothing renders', () => {
    const en = load('en')
    const text = sources().map((s) => s.text).join('\n')
    // A key can be rendered through a literal `t('x')`, a `reasonKey: 'x'`, or
    // built at runtime from a prefix. Only the first two are visible here, so
    // the check ignores anything whose prefix is clearly computed.
    const COMPUTED_PREFIXES = ['plugins.builtin.', 'settings.externalDesc.', 'capture.state.', 'capture.http.']
    const dead = Object.keys(en).filter((k) => {
      if (!DESCRIPTIVE.test(k)) return false
      if (COMPUTED_PREFIXES.some((p) => k.startsWith(p))) return false
      return !text.includes(`'${k}'`) && !text.includes(`"${k}"`) && !text.includes('`' + k)
    })
    // Dead prose is not a crash: it is a sentence someone wrote for an operator
    // who will never see it, sitting in the translation queue forever.
    expect(dead).toEqual([])
  })

  it('does not let a hint say exactly what its label already says', () => {
    const offenders: string[] = []
    for (const loc of LOCALES) {
      const dict = load(loc)
      const strip = (s: string): string => norm(s).replace(/[.!?。！？：:]+$/, '')
      for (const [k, v] of Object.entries(dict)) {
        if (!DESCRIPTIVE.test(k)) continue
        const ns = k.slice(0, k.lastIndexOf('.'))
        for (const [k2, v2] of Object.entries(dict)) {
          if (k2 === k || DESCRIPTIVE.test(k2)) continue
          if (!k2.startsWith(`${ns}.`)) continue
          // Exact equality after trailing punctuation, not a prefix match.
          //
          // A prefix rule was tried first and flagged
          // `firstRun.core.laterWhy` ("Core capture that is not verified stays
          // flagged…") because it opens with the heading's words. That sentence
          // says something the heading cannot, and a gate that fails on it is a
          // gate someone turns off. Only a hint that carries no information
          // beyond its label is caught here; judging whether prose is *worth*
          // saying is §2's four questions, not a regex.
          if (strip(v) === strip(v2)) offenders.push(`${loc}: ${k} repeats its label ${k2}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('does not give a control a tooltip that repeats its visible text', () => {
    const offenders: string[] = []
    for (const { file, text } of sources()) {
      // A tag scan: the opening tag, attributes only, no nested angle brackets.
      // The first version of this rule also accepted `=>` as an alternative to
      // `[^<>]`, which let the attribute group swallow an arrow function and
      // stop matching the tag it was attached to — and the rule silently
      // checked nothing. A mutation test caught it; keep the scanner simple.
      for (const m of text.matchAll(/<([A-Za-z][\w.]*)\b([^<>]*?)>/gs)) {
        const title = /title=\{t\('([^']+)'/.exec(m[2])
        if (!title) continue
        const end = text.indexOf('</', m.index! + m[0].length)
        const body = text.slice(m.index! + m[0].length, end === -1 ? undefined : end)
        // `t('key')` ends with `')`, so the character after the closing quote
        // is `)`, not `,` or `}`. The first version demanded `[,}]` and so
        // never matched a plain `{t('key')}` body at all.
        const visible = /\{t\('([^']+)'\)/.exec(body)
        if (visible && visible[1] === title[1]) {
          offenders.push(`${repoRelative(ROOT, path.join(ROOT, file))}: ${title[1]}`)
        }
      }
    }
    // A tooltip earns its place by saying something the label cannot — the full
    // value of a truncated name, the consequence of a destructive action.
    expect(offenders).toEqual([])
  })

  it('keeps helper lines to a sentence or two, and prose only where it is a warning', () => {
    const offenders: string[] = []
    for (const loc of LOCALES) {
      const dict = load(loc)
      const sentences = (v: string): number =>
        v.split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter(Boolean).length
      // Strings that are allowed to run long because they state a consequence the
      // operator must know before acting. Adding a key here is a decision, which
      // is the point: it cannot happen by accident.
      const WARNINGS = new Set([
        'ip.exposedHint',
        'firstRun.policy.why',
        'settings.clipboardScopeWarn',
        'settings.connectionMonitorSynNote',
        'settings.lootRuleStopped',
        'update.readyHint',
        'update.method.downloadPageMac',
        'plugins.consentBody',
        'bookmarks.emptyReason',
        'settings.integrityHint',
        'settings.rotationHint'
      ])
      for (const [k, v] of Object.entries(dict)) {
        if (!DESCRIPTIVE.test(k) || WARNINGS.has(k)) continue
        if (sentences(v) > 3) offenders.push(`${loc}: ${k} (${sentences(v)} sentences)`)
      }
    }
    expect(offenders).toEqual([])
  })
})
