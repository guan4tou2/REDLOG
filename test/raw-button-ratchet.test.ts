// UI/UX audit #592: `<button` and the shared `<Button` live side by side in
// components/. Some raw buttons are right (docs/UIUX-STANDARD.md §4.1 lists
// them: whole-row surfaces, icon-only controls with an aria-label, tab and
// list-item semantics); the rest are drift. Nobody is rewriting 220 of them in
// one change, so this is a ratchet: the raw count may go down, never up.
//
// To lower it: convert a raw button to `Button`/`IconButton` (or delete it),
// then set RAW_BUTTON_BASELINE to the new count (temporarily set it to 0 and
// read the "now" figure from the failure message). A new control that fits one of the §4.1 cases still
// adds to the count — raise the baseline in the same change and say why in the
// PR, so the growth is a decision someone reviewed.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

// Counted 2026-11-11 (the #677 jump links and the #561 session picker trigger added one each), excluding the two files that implement
// the shared controls (they render the one raw <button> each).
const RAW_BUTTON_BASELINE = 224
const IMPLEMENTATIONS = new Set([
  'src/renderer/src/components/Button.tsx',
  'src/renderer/src/components/IconButton.tsx'
])

function count(re: RegExp): number {
  let n = 0
  for (const file of glob.sync('src/renderer/src/components/**/*.tsx', { cwd: ROOT, absolute: true })) {
    if (IMPLEMENTATIONS.has(repoRelative(ROOT, file))) continue
    n += [...fs.readFileSync(file, 'utf8').matchAll(re)].length
  }
  return n
}

describe('raw <button> in components', () => {
  it('does not grow past the recorded baseline', () => {
    const raw = count(/<button\b/g)
    const shared = count(/<Button\b/g)
    expect(raw, `raw <button now ${raw} (baseline ${RAW_BUTTON_BASELINE}; shared <Button ${shared}). ` +
      'Use Button/IconButton, or see UIUX-STANDARD §4.1 and raise the baseline with a reason.')
      .toBeLessThanOrEqual(RAW_BUTTON_BASELINE)
  })
})
