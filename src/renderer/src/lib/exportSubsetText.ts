import { formatDateTime } from './time'
import type { ExportRequest } from '../../../core/export-plan'

// One wording for "what is being exported", used by the format menu (before
// anything is previewed) and by the preview itself, so the two cannot say
// different things about the same selection.

type T = (key: string, vars?: Record<string, string | number>) => string
type Subset = NonNullable<ExportRequest['subset']>

/** The conditions of a current-selection export, one phrase each. */
export function selectionConditions(subset: Extract<Subset, { kind: 'selection' }>, t: T): string[] {
  return [
    ...Object.entries(subset.filter).filter(([, value]) => value != null && value !== '').map(([key, value]) =>
      `${t(`export.condition.${key}`)}: ${key === 'since' || key === 'before' ? formatDateTime(Number(value), { seconds: true }) : typeof value === 'boolean' ? t(value ? 'export.condition.enabled' : 'export.condition.disabled') : String(value)}`),
    ...(subset.query ? [`${t('export.condition.query')}: ${subset.query}`] : []),
    ...Object.entries(subset.http ?? {}).filter(([, value]) => value != null && value !== '').map(([key, value]) => `${t(`export.condition.${key}`)}: ${value}`)
  ]
}

/** What a subset covers, in a sentence's worth of words. A selection with no
 *  condition says so: it is every stored event, not "the current view". */
export function subsetSummary(subset: Subset | undefined, t: T): string {
  if (!subset || subset.kind === 'all') return t('export.preview.subsetAll')
  if (subset.kind === 'selection') return selectionConditions(subset, t).join(' · ') || t('export.range.noFilter')
  if (subset.kind === 'activity' || subset.kind === 'session') return `${t(`activity.export.${subset.kind}`)} · ${subset.anchorEventId}`
  const span = `${formatDateTime(subset.since, { seconds: true })} → ${formatDateTime(subset.before, { seconds: true })}`
  return subset.targetId ? `${span} · ${t('export.preview.subsetTarget', { target: subset.targetId })}` : span
}
