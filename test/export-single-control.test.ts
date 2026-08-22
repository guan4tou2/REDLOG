import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// §10 and phase-3 item 13: one export control.
//
// Exporting was reachable from six places, each worded its own way — the
// dashboard, three separate groups in Settings, the timeline's slice button,
// and the transcript's. An operator writing an engagement up had to already
// know which one produced the thing they wanted, and the answer was not
// guessable from the labels.
//
// The fix was not to pick a winner but to notice that the scope of an export
// is a property of the export, not of where the button sits. Once scope is an
// option, six locations collapse to one control with three options — and the
// only thing a view still contributes is the part it alone knows.

const ROOT = path.join(__dirname, '..')
const R = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')

/** Every renderer file, so a seventh entry point cannot appear unnoticed. */
function rendererFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(e.name)) out.push(full)
    }
  }
  walk(path.join(ROOT, 'src/renderer/src'))
  return out
}

describe('one export control', () => {
  it('calls the file-writing export APIs from exactly one component', () => {
    const callers = rendererFiles().filter((f) =>
      /window\.redlog\.data\.export(Json|Bundle|ScopeFiltered)\b/.test(fs.readFileSync(f, 'utf-8'))
    )
    expect(callers.map((f) => path.basename(f))).toEqual(['ExportMenu.tsx'])
  })

  it('lets a view contribute its own scope instead of its own button', () => {
    // The timeline knows what "the visible range" means and nothing else
    // does. It contributes that; it does not render a second export button.
    const timeline = R('src/renderer/src/components/Timeline.tsx')
    expect(timeline).toMatch(/useContributeExport/)
    expect(timeline).not.toMatch(/timeline\.exportSlice['"]\)\}<\/button>/)
  })

  it('clears the view contribution on unmount', () => {
    // An option labelled "the visible time range" that still means the
    // previous view's range is worse than no option at all.
    const store = R('src/renderer/src/lib/exportScope.ts')
    expect(store).toMatch(/return \(\) => \{\s*current = null/)
  })

  it('previews what each option will produce', () => {
    // A wrong export is cheap; discovering it was wrong after opening the
    // file is a wasted round trip during the one task this record exists for.
    const menu = R('src/renderer/src/components/ExportMenu.tsx')
    expect(menu).toMatch(/export\.preview/)
    expect(menu).toMatch(/humanSize/)
  })

  it('keeps copy-to-clipboard out of the file-export menu', () => {
    // The transcript's Markdown button writes the clipboard, not a file. It
    // was counted as one of the six and is not one of them; folding it in
    // would have made the count tidier and the action worse.
    const transcript = R('src/renderer/src/components/TranscriptView.tsx')
    expect(transcript).toMatch(/copyAsMarkdown/)
    expect(transcript).toMatch(/clipboard\.writeText/)
    expect(transcript).not.toMatch(/window\.redlog\.data\.export/)
  })
})
