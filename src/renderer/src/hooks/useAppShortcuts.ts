import { useEffect } from 'react'
import { appShortcuts } from '../lib/shortcuts'
import { DEFAULT_ORDER, type SidebarViewId, NUMBERED_SLOTS } from '../lib/sidebarOrder'
import { isMac } from '../lib/platform'
import { toast } from '../components/Toast'

type View = SidebarViewId | 'settings'

const SETTINGS_SHORTCUT_INDEX = 9

// ---- Sidebar-order helpers (shared with DashboardView) ---- //

export function currentShortcutOrder(): View[] {
  return DEFAULT_ORDER.slice(0, NUMBERED_SLOTS) as View[]
}

export function viewForShortcut(num: number): View | null {
  if (num === SETTINGS_SHORTCUT_INDEX) return 'settings' as View
  const order = currentShortcutOrder()
  return num >= 1 && num <= order.length ? order[num - 1] : null
}

// ---- Hook ---- //

export function useAppShortcuts(
  project: { id: string; name: string } | null,
  view: View,
  setView: (v: View) => void,
  setPaletteOpen: (open: boolean) => void,
  t: (key: string, params?: Record<string, unknown>) => string
): void {
  // Cmd/Ctrl+1..N follow the sidebar's current (possibly user-reordered) order.
  // Re-read fresh inside the handler so a drag-reorder in the sidebar takes
  // effect immediately, without needing to re-attach the listener.
  //
  // Also handles a few app-wide shortcuts that don't fit the numeric-nav bucket.
  // Audit finding #78 batched here; per-view shortcuts (Cmd+T new tab, Cmd+W close
  // tab) are handled inside the terminal view where they can hit the right
  // handler without conflicting with system shortcuts elsewhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!project) return
      // Dispatch off the one table (lib/shortcuts.ts) rather than a ladder of
      // hand-written conditions. The table is what the Dashboard cheatsheet
      // and the Timeline's `?` panel render, so a binding that works and a
      // binding that is documented are now the same fact — the cheatsheet had
      // drifted four bindings behind before this.
      const rows = appShortcuts(currentShortcutOrder(), isMac)
      const hit = rows.find((r) => r.match?.(e))
      if (!hit) return

      // Only the rows that ask for it yield to a focused text field. A blanket
      // guard here is what broke Cmd+1..9 while the Terminal was open — xterm
      // keeps a hidden textarea focused for as long as that view is mounted.
      if (hit.guardTyping) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
        const typing = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable
        if (typing) return
      }

      if (hit.scope === 'nav') {
        const target = hit.id === 'nav:settings' ? ('settings' as View) : viewForShortcut(parseInt(hit.keys.slice(-1)))
        if (!target) return
        e.preventDefault()
        setView(target)
        return
      }

      switch (hit.id) {
        case 'app:palette': {
          // §10: Cmd+K is the same palette on every view. It used to mean two
          // different things — the Timeline's local fuzzy search there, the
          // Search sidebar page everywhere else — so an operator had to know
          // which surface they were on to know what the key did.
          e.preventDefault()
          setPaletteOpen(true)
          return
        }
        case 'app:findInPage': {
          // §5.7 / §10: in-page filtering is Cmd+F, which every other desktop
          // app has already taught. The view that has a filter takes it; the
          // ones that do not simply ignore the event.
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('redlog:find-in-page'))
          return
        }
        case 'app:toggleRecording': {
          e.preventDefault()
          window.redlog.recording.toggle().then((on) => {
            toast(on ? t('toast.recordingResumed') : t('toast.recordingPaused'), on ? 'success' : 'warning')
          }).catch((err) => {
            // A silently-swallowed toggle is the worst failure on the most
            // trust-sensitive action: the operator believes capture paused and
            // it did not (or the reverse). Surface it — the dot only flips if
            // main actually changed state, so an error here means it didn't.
            toast(t('toast.recordingToggleFailed'), {
              type: 'error',
              why: t('toast.recordingToggleFailedWhy'),
              detail: err instanceof Error ? err.message : String(err)
            })
          })
          return
        }
        case 'app:hudCorner': {
          // Clockwise around the four corners: up = TL, right = TR, down = BR, left = BL.
          // Reads as "pick the corner in that direction on a compass rose."
          // Cmd+Shift+Alt rather than Cmd+Alt because macOS Sequoia's window tiling grabs
          // the latter before the app sees it (audit finding #53).
          const corner: 'tl' | 'tr' | 'bl' | 'br' =
            e.key === 'ArrowUp' ? 'tl'
              : e.key === 'ArrowRight' ? 'tr'
                : e.key === 'ArrowDown' ? 'br'
                  : 'bl'
          e.preventDefault()
          window.redlog.overlay.moveToCorner?.(corner)
        }
      }
    }
    // The status bar's fault counters live below the view switcher and cannot
    // reach `setView` directly, so they ask by event (§9 — an issue names the
    // view where it can be dealt with).
    const onNavigate = (e: Event): void => {
      const target = (e as CustomEvent<string>).detail
      if (target) setView(target as View)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('redlog:navigate', onNavigate)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('redlog:navigate', onNavigate)
    }
    // `view` is read inside the handler to route Cmd+K in Timeline to the local
    // palette rather than the Search sidebar (v0.6.91 W3).
  }, [project, t, view, setView, setPaletteOpen])
}
