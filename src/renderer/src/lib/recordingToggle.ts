import { toast, toastUndo } from '../components/Toast'
import { appShortcuts } from './shortcuts'
import { isMac } from './platform'

type Translate = (key: string, vars?: Record<string, string | number>) => string

// The ⌘. chord, drawn the way this platform writes it. Read from the one
// shortcut table so the toast cannot drift from the binding (§11).
const recordingChord =
  appShortcuts([], isMac).find((r) => r.id === 'app:toggleRecording')?.keys ?? ''

// Toggle recording and, on failure, say so. A swallowed rejection here is the
// worst kind: the operator believes capture paused (or resumed) and the
// authoritative dot never moved. Resolves null when the toggle failed, so the
// caller skips the confirmation toast that would otherwise lie.
async function toggleOrReport(t: Translate): Promise<boolean | null> {
  try {
    return await window.redlog.recording.toggle()
  } catch (err) {
    toast(t('toast.recordingToggleFailed'), {
      type: 'error',
      why: t('toast.recordingToggleFailedWhy'),
      detail: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

// One pause/resume for every control that offers it — the status bar, ⌘. and
// the palette — so they fail the same way and offer the same undo.
export async function toggleRecordingWithFeedback(t: Translate): Promise<void> {
  const newState = await toggleOrReport(t)
  if (newState === null) return
  // Takes effect now — a pause that waited eight seconds would keep recording
  // exactly the thing the operator paused for. The undo is a second toggle,
  // which is why this is `toastUndo` and not `toastDeferred` (§10).
  toastUndo(
    newState ? t('toast.recordingResumed') : t('toast.recordingPaused'),
    () => { void toggleOrReport(t) },
    {
      type: newState ? 'success' : 'warning',
      why: newState ? undefined : t('toast.recordingPausedWhy'),
      // Name the action rather than saying "undo", and carry the chord —
      // pausing is the one toast an operator wants to reverse without reaching
      // for the mouse.
      ...(newState ? {} : {
        action: {
          label: `${t('statusBar.resumeRecording')}  ${recordingChord}`,
          onClick: () => { void toggleOrReport(t) }
        }
      })
    }
  )
}
