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

type Positions = Record<string, { x: number; y: number }>

function read(): Positions {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object') return {}
    return raw as Positions
  } catch {
    return {}
  }
}

/** The remembered position for the display the point is on, if any. */
export function loadOverlayPosition(): { x: number; y: number } | null {
  try {
    const display = screen.getPrimaryDisplay()
    const saved = read()[String(display.id)]
    if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return null
    // A display can change resolution, or the saved entry can predate a
    // rearrangement. Anything now off-screen falls back to the default rather
    // than putting the HUD somewhere the operator cannot reach it.
    const { workArea } = display
    const inside = saved.x >= workArea.x - 8 && saved.y >= workArea.y - 8
      && saved.x < workArea.x + workArea.width && saved.y < workArea.y + workArea.height
    return inside ? saved : null
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
    all[String(display.id)] = { x: b.x, y: b.y }
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2))
  } catch {
    /* a HUD that cannot remember where it was is not worth an error dialog */
  }
}
