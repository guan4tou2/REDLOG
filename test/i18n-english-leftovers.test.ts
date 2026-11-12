// English left in the zh-TW UI, in its two shapes:
//
// 1. A zh-TW value identical to the English one. Most are identifiers or
//    proper nouns that stay English in both (HTTP, PID, SHA-256, Claude Code);
//    those are listed below by key. Anything else identical is an untranslated
//    word and fails here.
// 2. English written straight into JSX instead of through t(). That is a
//    ratchet on the count: it may go down, never up.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import ts from 'typescript'
import zh from '../src/renderer/src/i18n/zh-TW.json'
import en from '../src/renderer/src/i18n/en.json'

const ROOT = path.join(__dirname, '..')

/** Identical in both locales on purpose: identifiers, protocol and tool
 *  names, formats, and three still awaiting a wording decision (marked). */
const SAME_IN_BOTH = new Set([
  'timeline.shell', 'timeline.dns', 'timeline.http', 'statusBar.overlay', 'settings.displayZoneUtc',
  'settings.ipMode.dns', 'settings.ipMode.http', 'settings.overlayGroup', 'settings.fileWatcherIgnorePlaceholder',
  'settings.processMonitorIgnorePlaceholder', 'settings.cdp', 'toast.repeat', 'timeline.detail.stdout',
  'timeline.detail.stderr', 'toolCard.env.shell', 'toolCard.env.shellUnknown', 'toolCard.mode.pty',
  'capture.agentClaudeCode', 'capture.agentCodex', 'transcript.kind.shell', 'transcript.kind.http',
  'sidebar.httpHistory', 'sidebar.http_history', 'timeline.detail.setCookies', 'marker.readonly.hash',
  'screenshots.trigger.api', 'activity.reader.field.pid', 'loot.type.jwt',
  // Awaiting a wording decision: the capture-mode names are the values the
  // zh-TW capture text itself uses (`capture_mode native`, "relay"); the
  // tagline is branding; "flag" is a loot type name.
  'toolCard.mode.native', 'toolCard.mode.relayed', 'project.tagline', 'loot.type.flag'
])

/** English JSX text and string-literal labels in renderer components, counted
 *  2026-11-11. Most are identifiers that stay English (SHA-256, PID, WSL, tool
 *  and terminal names, the wordmark). Not yet decided: TierBadge's
 *  `aria-label="tier: chained|logged"` and WslPanel's "Shells:" label. */
const JSX_ENGLISH_BASELINE = 24

function jsxEnglish(): string[] {
  const out: string[] = []
  for (const file of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT })) {
    const sf = ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const at = (n: ts.Node): string => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
    const visit = (n: ts.Node): void => {
      if (ts.isJsxText(n)) {
        const s = n.getText().replace(/\s+/g, ' ').trim()
        // An HTML entity (&times;) is a glyph, not a word.
        if (/[A-Za-z]{2,}/.test(s.replace(/&[a-z]+;/g, ''))) out.push(`${at(n)} ${s}`)
      }
      if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer)
        && ['title', 'placeholder', 'aria-label', 'alt', 'label'].includes(n.name.getText())
        && /[A-Za-z]{2,}/.test(n.initializer.text)) out.push(`${at(n)} [${n.name.getText()}] ${n.initializer.text}`)
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}

describe('English left in the zh-TW UI', () => {
  it('translates every zh-TW value that is a word, not an identifier', () => {
    const zhMap = zh as Record<string, string>
    const enMap = en as Record<string, string>
    const same = Object.keys(enMap).filter((k) => zhMap[k] === enMap[k] && /[A-Za-z]{3,}/.test(enMap[k]) && !SAME_IN_BOTH.has(k))
    expect(same.map((k) => `${k} = ${enMap[k]}`)).toEqual([])
  })

  it('does not add English to JSX outside t()', () => {
    const found = jsxEnglish()
    expect(found.length, found.join('\n')).toBeLessThanOrEqual(JSX_ENGLISH_BASELINE)
  })
})
