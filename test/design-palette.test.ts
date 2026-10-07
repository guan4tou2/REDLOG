// UI/UX audit F24: every colour class in the renderer names a shade the theme
// defines. A shade the theme does not set falls back silently to Tailwind's
// stock palette — vivid, and not RedLog's — which is how ~200 uses of
// red-200 / amber-900 / indigo-* / blue-* drifted in unnoticed.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'

const ROOT = path.join(__dirname, '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles/index.css'), 'utf8')
const theme = /@theme \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? ''
const DEFINED = new Set([...theme.matchAll(/--color-([a-z]+-\d+):/g)].map((m) => m[1]))

const HUES = 'red|rose|emerald|green|amber|yellow|cyan|blue|sky|indigo|violet|purple|fuchsia|pink|orange|lime|teal|zinc|gray|slate|neutral|stone'
const CLASS = new RegExp(`\\b(?:text|bg|border|ring|from|to|via|fill|stroke|accent|decoration|outline|divide|placeholder|shadow|caret)-(${HUES})-(\\d{2,3})\\b`, 'g')

describe('the renderer palette', () => {
  it('uses only shades the theme defines', () => {
    const files = glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT })
    const undefinedUses: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      for (const m of src.matchAll(CLASS)) {
        const shade = `${m[1]}-${m[2]}`
        if (!DEFINED.has(shade)) undefinedUses.push(`${f}: ${m[0]}`)
      }
    }
    expect(undefinedUses).toEqual([])
  })

  it('keeps inline hex colours to the places that cannot take a class', () => {
    // xterm's theme, the HUD's own window, the canvas-drawn replay and the
    // wordmark take colour strings, not classes; everything else uses tokens.
    const allowed = new Set([
      'src/renderer/src/components/TerminalView.tsx',
      'src/renderer/src/OverlayApp.tsx',
      'src/renderer/src/lib/hud.ts',
      'src/renderer/src/components/SessionReplayPlayer.tsx',
      'src/renderer/src/components/Wordmark.tsx',
      // The Timeline's colours, kept as hex because it appends alpha to them.
      'src/renderer/src/lib/timelineDomain.ts'
    ])
    const files = glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT })
    const offenders = files.filter((f) => !allowed.has(f)
      && /['"`]#[0-9a-fA-F]{3,8}\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
