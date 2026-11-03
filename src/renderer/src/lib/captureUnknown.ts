import { formatTime } from './time'

/** What to say instead of a verdict when the last read failed: when the verdict
 *  was last confirmed, and what it was. The old verdict is not drawn, only
 *  named, with the time that dates it. */
export function captureUnknownLine(
  t: (key: string, vars?: Record<string, string | number>) => string,
  last: { verdict?: string } | null,
  lastOkAt: number | null
): string {
  const verdict = last?.verdict
  if (lastOkAt === null || (verdict !== 'healthy' && verdict !== 'partial' && verdict !== 'dark')) {
    return t('capture.unknownNever')
  }
  return t('capture.unknownSince', { state: t(`capture.confirmed.${verdict}`), time: formatTime(lastOkAt) })
}
