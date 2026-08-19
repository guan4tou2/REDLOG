import { describe, it, expect, vi } from 'vitest'

// The module pulls Menu/BrowserWindow in for the popup paths; the two functions
// under test are pure, so a stub keeps this a plain unit test outside Electron.
vi.mock('electron', () => ({ Menu: {}, BrowserWindow: {} }))

const { buildContextMenuTemplate, sanitizeRendererMenu } = await import('../src/main/context-menu')

const FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }

describe('buildContextMenuTemplate', () => {
  it('gives an editable field the full edit menu', () => {
    const t = buildContextMenuTemplate({ isEditable: true, selectionText: '', editFlags: FLAGS })
    expect(t.map((i) => i.role ?? i.type)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll'])
  })

  it('greys out what the field cannot do rather than hiding it', () => {
    // Read-only input with nothing selected: Cut/Copy are dead, Paste is not.
    const t = buildContextMenuTemplate({
      isEditable: true,
      selectionText: '',
      editFlags: { ...FLAGS, canCut: false, canCopy: false }
    })
    const byRole = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i.enabled]))
    expect(byRole).toMatchObject({ cut: false, copy: false, paste: true, selectAll: true })
  })

  it('offers only Copy for a plain selection outside a field', () => {
    const t = buildContextMenuTemplate({
      isEditable: false,
      selectionText: '10.0.0.7',
      editFlags: FLAGS
    })
    expect(t).toEqual([{ role: 'copy' }])
  })

  it('returns nothing when there is nothing to act on', () => {
    // This empty case is load-bearing: it is what lets the terminal pane own
    // its own right-click instead of a useless all-greyed-out menu appearing
    // over xterm (whose selection never reaches the DOM).
    expect(buildContextMenuTemplate({ isEditable: false, selectionText: '', editFlags: FLAGS })).toEqual([])
    expect(buildContextMenuTemplate({ isEditable: false, selectionText: '  \n ', editFlags: FLAGS })).toEqual([])
  })
})

describe('sanitizeRendererMenu', () => {
  it('keeps well-formed items and defaults enabled to true', () => {
    expect(sanitizeRendererMenu([{ id: 'copy', label: 'Copy' }, { id: 'paste', label: 'Paste', enabled: false }]))
      .toEqual([
        { id: 'copy', label: 'Copy', enabled: true },
        { id: 'paste', label: 'Paste', enabled: false }
      ])
  })

  it('drops items with no id, no label, or an over-long one', () => {
    const out = sanitizeRendererMenu([
      { label: 'no id' },
      { id: 'x' },
      { id: 'ok', label: '   ' },
      { id: 'y'.repeat(33), label: 'long id' },
      { id: 'z', label: 'l'.repeat(65) },
      { id: 'good', label: 'Good' }
    ])
    expect(out.map((i) => i.id)).toEqual(['good'])
  })

  it('never leaves a separator floating at either end or doubled up', () => {
    const out = sanitizeRendererMenu([
      { type: 'separator' },
      { id: 'a', label: 'A' },
      { type: 'separator' },
      { type: 'separator' },
      { id: 'b', label: 'B' },
      { type: 'separator' }
    ])
    expect(out.map((i) => i.type ?? i.id)).toEqual(['a', 'separator', 'b'])
  })

  it('caps the item count and rejects non-array payloads', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }))
    expect(sanitizeRendererMenu(many)).toHaveLength(16)
    expect(sanitizeRendererMenu(null)).toEqual([])
    expect(sanitizeRendererMenu('copy')).toEqual([])
    expect(sanitizeRendererMenu([null, undefined, 'x', 7])).toEqual([])
  })
})
