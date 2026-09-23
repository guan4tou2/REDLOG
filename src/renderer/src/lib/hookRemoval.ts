import { toast, toastDeferred } from '../components/Toast'

type T = (key: string, vars?: Record<string, string | number>) => string

/**
 * Removing a hook blinds a capture source, and a blind source is only
 * discovered later, in the gap it left in the timeline. SS10 defers it: the
 * caller shows the hook removed at once, the profile is not touched until the
 * undo window closes, and an undo inside it leaves no audit entry.
 *
 * Settings ▸ Hooks and the capture card both remove hooks through here; the
 * card used to uninstall at once, with no way back.
 */
export function removeHookWithUndo(hookId: string, t: T, view: {
  /** Show the hook removed now. */
  hide: () => void
  /** Undone, or the uninstall failed: show it installed again. */
  restore: () => void
  /** The uninstall ran: re-read the real state. */
  refresh: () => void
}): void {
  view.hide()
  const failed = (detail?: string): void => {
    view.restore()
    toast(t('settings.hookUninstallFailed', { name: hookId }), {
      type: 'error', why: t('settings.hookFailedWhy'), detail
    })
  }
  toastDeferred(
    t('settings.hookRemoved', { name: hookId }),
    () => {
      void window.redlog.hooks.uninstall(hookId)
        .then((r) => { if (!r.success) failed(r.message ?? r.error) })
        .catch((e: unknown) => failed(e instanceof Error ? e.message : String(e)))
        .finally(view.refresh)
    },
    { type: 'warning', why: t('settings.hookRemovedWhy'), revert: view.restore }
  )
}
