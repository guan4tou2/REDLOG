import { useI18n } from '../i18n'
import { LIST_PAGE_SIZE } from '../lib/useInfiniteScroll'

// The "已載入 N／共 M" footer for infinitely-scrolled row lists (§9). Shows the
// sentinel that pulls the next page and the loaded-of-total count. Renders
// nothing for a list short enough that it never pages — the count would be
// noise ("N of N") and there's nothing more to load.
export function ListFooter({ shown, total, sentinelRef }: {
  shown: number
  total: number
  sentinelRef: (node: Element | null) => void
}): JSX.Element | null {
  const { t } = useI18n()
  if (total <= LIST_PAGE_SIZE) return null
  return (
    <div className="py-2 text-center text-xs text-redlog-text-faint" aria-live="polite">
      <div ref={sentinelRef} aria-hidden="true" />
      {t('list.loadedOfTotal', { shown, total })}
    </div>
  )
}
