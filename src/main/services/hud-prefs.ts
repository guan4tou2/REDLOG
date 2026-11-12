import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_HUD_PREFS, mergeHudPrefs, type HudPrefs } from '../../core/hud-prefs'
import { mkdirPrivate } from '../../core/private-fs'

// The HUD's settings, machine-wide (src/core/hud-prefs.ts says why). One JSON
// file beside overlay-position.json. Reading never throws: a missing or broken
// file is the defaults, so the HUD always opens.

const FILE = 'hud-prefs.json'

export function hasHudPrefs(dir: string): boolean {
  return fs.existsSync(path.join(dir, FILE))
}

export function readHudPrefs(dir: string): HudPrefs {
  try {
    return mergeHudPrefs(DEFAULT_HUD_PREFS, JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf-8')))
  } catch {
    return { ...DEFAULT_HUD_PREFS }
  }
}

export function writeHudPrefs(dir: string, prefs: HudPrefs): void {
  mkdirPrivate(dir)
  const file = path.join(dir, FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** The one migration: with no file yet, the first project opened gives its
 *  old `overlay:` block (or nothing, for the defaults). After that the file is
 *  the only source and project files are never consulted again. */
export function seedHudPrefs(dir: string, legacyOverlay: unknown): HudPrefs {
  if (hasHudPrefs(dir)) return readHudPrefs(dir)
  const prefs = mergeHudPrefs(DEFAULT_HUD_PREFS, legacyOverlay)
  writeHudPrefs(dir, prefs)
  return prefs
}
