import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import glob from 'fast-glob'

// On Windows and Linux the OS draws its window buttons over the top-right of
// the page (lib/captionInsets). A surface that covers the whole window and puts
// something there is under them. Every full-window surface either starts below
// the strip (`pt-caption`) or says why it cannot reach it. A new one that does
// neither fails here, rather than on an operator's Windows machine.

const ROOT = path.join(__dirname, '..', 'src', 'renderer', 'src')

/** Full-window surfaces that do not use `pt-caption`, and why that is safe. */
const EXEMPT: Array<{ file: string; line: string; reason: string }> = [
  { file: 'components/TerminalView.tsx', line: 'fixed inset-0 z-40', reason: 'an invisible click-catcher behind a menu; it holds nothing' },
  { file: 'components/timeline/TimelineToolbar.tsx', line: 'fixed inset-0 z-30', reason: 'an invisible click-catcher behind a menu; it holds nothing' },
  { file: 'components/ExportMenu.tsx', line: 'fixed inset-0 z-[90]', reason: 'only the dimmed backdrop; the dialog is centred and at most 82vh tall, so it stays below the strip' },
  { file: 'components/ConfirmDialog.tsx', line: 'fixed inset-0 z-[200]', reason: 'a short dialog centred in the window' },
  { file: 'components/CommandPalette.tsx', line: 'fixed inset-0 z-[150]', reason: 'starts 12vh down, already below the 40px strip at the 500px window floor, and is centred' },
  { file: 'components/EventMarker.tsx', line: 'fixed inset-0 bg-black/60', reason: 'a short dialog centred in the window' },
  { file: 'components/TimelineHelpModal.tsx', line: 'fixed inset-0 z-50', reason: 'starts 96px down (pt-24), below the strip' }
]

function fullWindowLines(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const file of glob.sync('**/*.tsx', { cwd: ROOT })) {
    for (const text of readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
      if (/fixed inset-0(?![\w-])/.test(text)) out.push({ file, text })
    }
  }
  return out
}

describe('window buttons: nothing full-window ignores the strip', () => {
  it('every `fixed inset-0` surface uses pt-caption or is listed with a reason', () => {
    const offenders = fullWindowLines()
      .filter(({ text }) => !text.includes('pt-caption'))
      .filter(({ file, text }) => !EXEMPT.some((e) => e.file === file && text.includes(e.line)))
      .map(({ file, text }) => `${file}: ${text.trim().slice(0, 120)}`)
    expect(offenders, 'a full-window surface that can reach the top-right corner is drawn under the OS window buttons on Windows/Linux; add pt-caption, or list it in EXEMPT with the reason it cannot').toEqual([])
  })

  it('every exemption still matches a line, so the list cannot rot', () => {
    const lines = fullWindowLines()
    const stale = EXEMPT.filter((e) => !lines.some((l) => l.file === e.file && l.text.includes(e.line) && !l.text.includes('pt-caption')))
    expect(stale.map((e) => `${e.file}: ${e.line}`)).toEqual([])
  })

  it('the utilities exist, and the title strip reserves through them rather than a literal', () => {
    const css = readFileSync(path.join(ROOT, 'styles', 'index.css'), 'utf8')
    for (const u of ['pr-caption', 'mr-caption', 'pt-caption']) expect(css).toMatch(new RegExp(`@utility ${u}\\b`))
    const app = readFileSync(path.join(ROOT, 'App.tsx'), 'utf8')
    // 144 CSS px is 129.6 px on screen at the default zoom: less than three Windows buttons need.
    expect(app).not.toMatch(/\b(?:pr|mr)-36\b/)
    expect(app).toContain('pr-caption')
    expect(app).toContain('mr-caption')
  })
})
