// One manual screenshot, with the same feedback wherever it is asked for —
// the palette said whether it worked, the Screenshots page button said nothing.
import { toast } from '../components/Toast'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Resolves the new screenshot's event id, or null when nothing was stored. */
export async function captureScreenshotWithFeedback(t: Translate): Promise<string | null> {
  try {
    const id = await window.redlog.screenshot.capture()
    // null means nothing new was stored: capturing failed or was refused
    // (Capture Health has which).
    if (id) toast(t('palette.screenshotTaken'), 'success')
    else toast(t('palette.screenshotNotSaved'), { type: 'warning', why: t('palette.screenshotNotSavedWhy') })
    return id
  } catch (err) {
    toast(t('palette.screenshotNotSaved'), { type: 'error', detail: err instanceof Error ? err.message : String(err) })
    return null
  }
}
