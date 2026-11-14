import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FIELD_FOCUS_RING } from '../src/renderer/src/components/Button'

// UIUX-STANDARD §5-8 and §25.4: focus is visible everywhere, and the ring sits
// outside the border. Seven search fields showed keyboard focus only as a
// border colour (`focus:outline-none focus:border-…`) — on a dark field, a
// change nobody can find. They now carry the buttons' ring, from one constant.

const COMPONENTS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'components')

/** Every <input>, <textarea> and <select> opening tag in a source file. Braces
 *  are counted so an arrow function's `=>` does not end the tag. */
function fieldTags(src: string): string[] {
  const out: string[] = []
  const open = /<(input|textarea|select)\b/g
  let m: RegExpExecArray | null
  while ((m = open.exec(src))) {
    let j = m.index + m[0].length
    let depth = 0
    let quote: string | null = null
    for (; j < src.length; j++) {
      const c = src[j]
      if (quote) { if (c === quote) quote = null; continue }
      if (depth === 0 && (c === '"' || c === "'")) quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push(src.slice(m.index, j + 1))
    open.lastIndex = j + 1
  }
  return out
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : [])
}

const read = (rel: string): string => fs.readFileSync(path.join(COMPONENTS, rel), 'utf8')

describe('text fields show keyboard focus with a ring', () => {
  it('the shared ring is the buttons\' ring: 2px, outside the border, in the accent', () => {
    for (const token of ['focus-visible:ring-2', 'focus-visible:ring-offset-2', 'focus-visible:ring-redlog-accent/40']) {
      expect(FIELD_FOCUS_RING.split(' ')).toContain(token)
    }
  })

  // [component file, a string that only that field's tag carries]
  const SEARCH_FIELDS: Array<[string, string, string]> = [
    ['Activity', 'RecordingWorkspace.tsx', 'data-testid="search-input"'],
    ['Targets', 'TargetView.tsx', 'data-testid="targets-search"'],
    ['Screenshots', 'ScreenshotsView.tsx', 'data-testid="screenshots-search"'],
    ['Loot', 'LootPanel.tsx', 'data-testid="loot-search"'],
    ['HTTP history filter', 'HttpHistoryPanel.tsx', "t('httpHistory.filterPlaceholder')"],
    ['Settings search', 'Settings.tsx', "t('settings.searchSettings')"],
    ['Timeline search', 'timeline/TimelineStatusStrips.tsx', "t('timeline.search.placeholder')"]
  ]
  it.each(SEARCH_FIELDS)('%s', (_name, file, marker) => {
    const tag = fieldTags(read(file)).filter((t) => t.includes(marker))
    expect(tag, `${file}: no field tag carries ${marker}`).toHaveLength(1)
    expect(tag[0]).toContain('FIELD_FOCUS_RING')
  })

  // Borderless fields that fill an open popover or palette: the open panel is
  // where focus went, and a ring would box a field that has no box.
  const LEFT = new Set(['CommandPalette.tsx', 'SourceSessionPicker.tsx'])

  it('no other field turns the outline off without a ring in its place', () => {
    const bare: string[] = []
    for (const file of walk(COMPONENTS)) {
      const rel = path.relative(COMPONENTS, file).split(path.sep).join('/')
      if (LEFT.has(rel)) continue
      for (const tag of fieldTags(fs.readFileSync(file, 'utf8'))) {
        if (!/(^|[\s"`])(focus:)?outline-none\b/.test(tag)) continue
        if (tag.includes('FIELD_FOCUS_RING') || /focus(-visible)?:ring-2/.test(tag)) continue
        bare.push(`${rel}: ${tag.slice(0, 80).replace(/\s+/g, ' ')}`)
      }
    }
    expect(bare).toEqual([])
  })
})
