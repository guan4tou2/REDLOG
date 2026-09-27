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
}

function base(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function artifactToast(r: ArtifactAddOutcome, t: Translate): ArtifactToast {
  const name = base(r.originalPath)
  if (r.ok) {
    if (r.eventId === null) {
      return { message: t('artifacts.notRecorded', { name }), type: 'error', why: t('artifacts.notRecordedWhy'), detail: r.stored }
    }
    const related = r.relatedCommands > 0 ? t('artifacts.related', { count: r.relatedCommands }) : undefined
    return r.duplicate
      ? { message: t('artifacts.duplicate', { name }), type: 'info', why: related, detail: `sha256 ${r.sha256}` }
      : { message: t('artifacts.added', { name }), type: 'success', why: related, detail: `sha256 ${r.sha256}` }
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

/** Open the picker (in the main process) and report every picked file. */
export async function addArtifactsWithFeedback(t: Translate): Promise<void> {
  let res: ArtifactAddResponse | null
  try {
    res = await window.redlog.artifacts.add()
  } catch (err) {
    toast(t('artifacts.pickerFailed'), { type: 'error', detail: err instanceof Error ? err.message : String(err) })
    return
  }
  if (!res) { toast(t('artifacts.none'), 'warning'); return }
  for (const r of res.results) {
    const { message, ...opts } = artifactToast(r, t)
    toast(message, { ...opts, key: `artifact:${r.originalPath}` })
  }
}
