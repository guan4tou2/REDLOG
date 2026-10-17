// Operator-added evidence files (#221): what each picked file came to, in
// words. Every outcome is visible — a file that was too large, a disk that
// filled, a duplicate — so an operator never assumes a file is in the
// project when it is not.

import { toast } from '../components/Toast'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export interface ArtifactToast {
  message: string
  type: 'success' | 'info' | 'warning' | 'error'
  why?: string
  detail?: string
  /** "Show": jumps to the row that was just recorded. */
  action?: { label: string; onClick: () => void }
}

/** Opens the timeline on a recorded event. */
export type ShowEvent = (eventId: string, timestamp: number) => void

function base(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function artifactToast(r: ArtifactAddOutcome, t: Translate, onShow?: ShowEvent): ArtifactToast {
  const name = base(r.originalPath)
  if (r.ok) {
    if (r.eventId === null) {
      return { message: t('artifacts.notRecorded', { name }), type: 'error', why: t('artifacts.notRecordedWhy'), detail: r.stored }
    }
    const related = r.relatedCommands > 0 ? t('artifacts.related', { count: r.relatedCommands }) : undefined
    const eventId = r.eventId
    // The row was written a moment ago, so "now" is where the timeline needs to look.
    const action = onShow ? { label: t('artifacts.show'), onClick: () => onShow(eventId, Date.now()) } : undefined
    return r.duplicate
      ? { message: t('artifacts.duplicate', { name }), type: 'info', why: related, detail: `sha256 ${r.sha256}`, action }
      : { message: t('artifacts.added', { name }), type: 'success', why: related, detail: `sha256 ${r.sha256}`, action }
  }
  switch (r.error) {
    case 'too-large':
      return { message: t('artifacts.tooLarge', { name }), type: 'warning', why: t('artifacts.tooLargeWhy', { size: mb(r.bytes ?? 0) }) }
    case 'no-space':
      return { message: t('artifacts.noSpace', { name }), type: 'error', why: t('artifacts.noSpaceWhy') }
    case 'not-a-file':
      return { message: t('artifacts.notAFile', { name }), type: 'warning' }
    case 'unreadable':
      return { message: t('artifacts.unreadable', { name }), type: 'error', detail: r.detail }
    default:
      return { message: t('artifacts.failed', { name }), type: 'error', detail: r.detail }
  }
}

/** Say what became of each file: one summary for several, a toast of its own
 *  for every file that was not added. */
function reportResults(res: ArtifactAddResponse | null, t: Translate, onShow?: ShowEvent): void {
  if (!res) { toast(t('artifacts.none'), 'warning'); return }
  // One file: its own toast. Several: one summary for what was added, and a
  // toast of its own for every file that was not — a failure must never be
  // folded into a count (UI/UX audit F4).
  const added = res.results.filter((r) => r.ok && r.eventId !== null)
  if (res.results.length > 1 && added.length > 0) {
    // "Show" opens the last one recorded; the rest sit beside it in the timeline.
    const last = added[added.length - 1]
    const lastId = last.ok ? last.eventId : null
    toast(t('artifacts.addedMany', { count: added.length, total: res.results.length }), {
      type: added.length === res.results.length ? 'success' : 'info',
      ...(onShow && lastId ? { action: { label: t('artifacts.show'), onClick: () => onShow(lastId, Date.now()) } } : {})
    })
  }
  for (const r of res.results) {
    if (res.results.length > 1 && r.ok && r.eventId !== null) continue
    const { message, ...opts } = artifactToast(r, t, onShow)
    toast(message, { ...opts, key: `artifact:${r.originalPath}` })
  }
}

/** Open the picker (in the main process) and report every picked file. */
export async function addArtifactsWithFeedback(t: Translate, onShow?: ShowEvent): Promise<void> {
  try {
    reportResults(await window.redlog.artifacts.add(t('artifacts.pickerTitle')), t, onShow)
  } catch (err) {
    toast(t('artifacts.pickerFailed'), { type: 'error', detail: err instanceof Error ? err.message : String(err) })
  }
}

/** Files dropped on the window: the main process confirms the list first. */
export async function addDroppedWithFeedback(files: File[], t: Translate, onShow?: ShowEvent): Promise<void> {
  if (files.length === 0) return
  try {
    reportResults(await window.redlog.artifacts.addDropped(files, {
      title: t('artifacts.pickerTitle'),
      message: t('artifacts.dropConfirm', { count: files.length }),
      confirm: t('artifacts.dropConfirmYes'),
      cancel: t('common.cancel')
    }), t, onShow)
  } catch (err) {
    toast(t('artifacts.pickerFailed'), { type: 'error', detail: err instanceof Error ? err.message : String(err) })
  }
}
