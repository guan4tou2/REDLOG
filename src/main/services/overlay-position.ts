import { screen, type BrowserWindow } from 'electron'
import { homedir } from 'os'
import fs from 'fs'
import path from 'path'

// Where the HUD sits, remembered per display (docs/UIUX-STANDARD.md §8).
//
// Per display rather than one global position, because the position an
// operator picks is a statement about *that* screen's layout — clear of the
// notch on the laptop, clear of the terminal on the external monitor. Carrying
// one coordinate between them puts the HUD somewhere wrong on both, and on a
// smaller second screen it can put it off-screen entirely.
//
// Stored outside the project directory for the same reason tokens are: it is a
// property of this machine, not of the engagement, and nothing about it belongs
// in an evidence bundle.

const FILE = path.join(homedir(), '.redlog', 'overlay-position.json')

/** `at` is when it was saved; entries written before it existed have none. */
type Saved = { x: number; y: number; at?: number }
type Positions = Record<string, Saved>
type Display = { id: number; workArea: { x: number; y: number; width: number; height: number } }

function read(): Positions {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object') return {}
    return raw as Positions
  } catch {
    return {}
  }
}

/** Of the displays still attached, the one the HUD was most recently put on,
 *  and where on it. A display that is gone is skipped, and so is a saved
 *  point that has fallen off its display — it can change resolution, or the
 *  entry can predate a rearrangement — rather than put the HUD where the
 *  operator cannot reach it. Ties (old entries with no time) go to the
 *  primary display. */
function pickOverlayPosition(saved: Positions, displays: Display[], primaryId: number): { x: number; y: number } | null {
  let best: { x: number; y: number; at: number; primary: boolean } | null = null
  for (const d of displays) {
    const s = saved[String(d.id)]
    if (!s || typeof s.x !== 'number' || typeof s.y !== 'number') continue
    const { workArea } = d
    const inside = s.x >= workArea.x - 8 && s.y >= workArea.y - 8
      && s.x < workArea.x + workArea.width && s.y < workArea.y + workArea.height
    if (!inside) continue
    const at = typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0
    const primary = d.id === primaryId
    if (!best || at > best.at || (at === best.at && primary && !best.primary)) best = { x: s.x, y: s.y, at, primary }
  }
  return best ? { x: best.x, y: best.y } : null
}

/** The remembered position to open the HUD at, if any still fits a screen. */
export function loadOverlayPosition(): { x: number; y: number } | null {
  try {
    return pickOverlayPosition(read(), screen.getAllDisplays(), screen.getPrimaryDisplay().id)
  } catch {
    return null
  }
}

/** Remember where the window is now, against whichever display it is on. */
export function saveOverlayPosition(win: BrowserWindow): void {
  try {
    if (win.isDestroyed()) return
    const b = win.getBounds()
    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y })
    const all = read()
    all[String(display.id)] = { x: b.x, y: b.y, at: Date.now() }
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2))
  } catch {
    /* a HUD that cannot remember where it was is not worth an error dialog */
  }
}
