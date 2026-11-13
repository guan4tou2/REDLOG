// Every page fills the main pane (docs/UIUX-STANDARD.md §27): no page-level
// width cap, no page-level centring. A class string cannot say whether a
// `max-w-*` sits on a page or on a dialog, so this is an explicit allowlist of
// the occurrences that may exist and why. A new one fails with its file:line;
// an entry whose line is gone fails too, so the list cannot go stale.
//
// Running prose does not appear here: it takes PROSE_WIDTH from
// lib/pageLayout.ts, the one place that defines the cap. `max-w-full` is 100%,
// not a cap, and is ignored.
//
// To add one: it must be a control, a dialog or popover, the launch-time
// project picker, an in-pane empty/error state, or an image in a viewer. If it
// is a page, a card or a list, it does not get a cap.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')
const CAP = /max-w-(?!full\b)|mx-auto/

type Kind = 'prose-token' | 'control' | 'dialog' | 'picker' | 'state' | 'image'
interface Allowed { file: string; snippet: string; kind: Kind }

const C = 'src/renderer/src/components/'
const ALLOWED: Allowed[] = [
  { file: 'src/renderer/src/lib/pageLayout.ts', snippet: "PROSE_WIDTH = 'max-w-[72ch]'", kind: 'prose-token' },
  { file: C + 'ActivityReader.tsx', snippet: 'w-full max-w-5xl flex flex-col rounded-xl', kind: 'dialog' },
  { file: C + 'CommandPalette.tsx', snippet: 'w-full max-w-xl mx-4', kind: 'dialog' },
  { file: C + 'ConfirmDialog.tsx', snippet: 'max-w-sm w-full max-h-full', kind: 'dialog' },
  { file: C + 'CreateProjectModal.tsx', snippet: 'panelClassName="w-full max-w-xl m-4', kind: 'dialog' },
  { file: C + 'ErrorBoundary.tsx', snippet: "t('fatal.why')", kind: 'state' },
  { file: C + 'ErrorBoundary.tsx', snippet: '{error.message}', kind: 'state' },
  { file: C + 'ErrorBoundary.tsx', snippet: 'w-full max-w-xl text-left mt-1', kind: 'state' },
  { file: C + 'FirstRunView.tsx', snippet: 'sm:max-w-sm', kind: 'control' },
  { file: C + 'HttpHistoryPanel.tsx', snippet: 'max-w-[200px]', kind: 'control' },
  { file: C + 'MarkerDetail.tsx', snippet: 'shrink-0 max-w-[100px] truncate', kind: 'control' },
  { file: C + 'ProjectPicker.tsx', snippet: 'w-full max-w-[740px] mx-auto', kind: 'picker' },
  { file: C + 'ScreenshotsView.tsx', snippet: 'panelClassName="flex flex-col items-center gap-2 max-w-[92vw]"', kind: 'dialog' },
  { file: C + 'ScreenshotsView.tsx', snippet: 'max-w-[90vw] max-h-[78vh]', kind: 'image' },
  { file: C + 'SourceSessionPicker.tsx', snippet: 'w-[28rem] max-w-[90vw]', kind: 'dialog' },
  { file: C + 'TargetView.tsx', snippet: 'flex-1 max-w-md rounded border', kind: 'control' },
  { file: C + 'TerminalView.tsx', snippet: 'truncate max-w-[100px]', kind: 'control' },
  { file: C + 'TerminalView.tsx', snippet: 'truncate max-w-[80px]', kind: 'control' },
  { file: C + 'TerminalView.tsx', snippet: 'w-[520px] max-w-[95vw]', kind: 'dialog' },
  { file: C + 'Timeline.tsx', snippet: 'timeline-load-failed', kind: 'state' },
  { file: C + 'TimelineHelpModal.tsx', snippet: 'w-[560px] max-w-[92vw]', kind: 'dialog' },
  { file: C + 'Toast.tsx', snippet: 'max-w-[380px]', kind: 'dialog' },
  { file: C + 'TranscriptView.tsx', snippet: 'flex-1 max-w-md bg-redlog-surface', kind: 'control' },
  { file: C + 'settings/NetworkPage.tsx', snippet: 'truncate max-w-[240px]', kind: 'control' },
  { file: C + 'settings/PluginsPanel.tsx', snippet: 'p-pad max-w-md mx-4', kind: 'dialog' },
  { file: C + 'timeline/TimelineEventInspector.tsx', snippet: 'truncate max-w-[280px]', kind: 'control' },
  { file: C + 'timeline/TimelineEventRail.tsx', snippet: 'shrink-0 max-w-[80px] truncate', kind: 'control' }
]

interface Hit { file: string; line: number; text: string }

function scan(): Hit[] {
  const hits: Hit[] = []
  for (const abs of glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const file = repoRelative(ROOT, abs)
    fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((text, i) => {
      if (CAP.test(text)) hits.push({ file, line: i + 1, text })
    })
  }
  return hits
}

describe('page width', () => {
  const hits = scan()

  it('no page-level width cap or centring: every max-w-* / mx-auto is an allowed occurrence', () => {
    const unknown = hits.filter(h => !ALLOWED.some(a => a.file === h.file && h.text.includes(a.snippet)))
    expect(unknown.map(h => `${h.file}:${h.line}  ${h.text.trim().slice(0, 120)}`),
      'A page fills the pane (UIUX-STANDARD §27). Running prose uses PROSE_WIDTH from lib/pageLayout.ts; ' +
      'a control, dialog, picker or in-pane state goes on the allowlist in this file with its kind.').toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const stale = ALLOWED.filter(a => !hits.some(h => h.file === a.file && h.text.includes(a.snippet)))
    expect(stale.map(a => `${a.file}  ${a.snippet}`), 'remove entries whose line no longer exists').toEqual([])
  })

  it('every allowlisted file exists', () => {
    for (const a of ALLOWED) expect(fs.existsSync(path.join(ROOT, ...a.file.split('/'))), a.file).toBe(true)
  })
})
