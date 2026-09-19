import { timelineShortcuts } from '../lib/shortcuts'

interface TimelineHelpModalProps {
  open: boolean
  onClose: () => void
  isMac: boolean
  t: (key: string, vars?: Record<string, string | number>) => string
}

export function TimelineHelpModal({ open, onClose, isMac, t }: TimelineHelpModalProps): JSX.Element | null {
  if (!open) return null
  return (
    <div
      data-testid="timeline-help"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[560px] max-w-[92vw] rounded-lg border border-redlog-border bg-redlog-bg shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-redlog-border">
          <span className="text-xs font-mono uppercase tracking-wider text-redlog-text-dim">{t('timeline.help.title')}</span>
          <button
            onClick={onClose}
            className="ml-auto text-xs text-redlog-text-dim hover:text-redlog-text leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-white/10"
            aria-label={t('timeline.help.close')}
            title={t('timeline.help.close')}
          >×</button>
        </div>
        <div className="px-4 py-3 space-y-3 max-h-[70vh] overflow-y-auto">
          {timelineShortcuts(isMac).map((group) => (
            <div key={group.label}>
              <div className="text-xs font-mono uppercase tracking-wider text-redlog-text-dim mb-1">{t(group.label)}</div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {group.rows.map((row) => (
                  <div key={row.keys} className="contents">
                    <kbd className="font-mono text-xs text-redlog-text bg-redlog-elevated border border-redlog-border rounded px-1.5 py-0.5 whitespace-nowrap">{row.keys}</kbd>
                    <span className="text-redlog-text-dim">{t(row.label)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-3 py-1.5 border-t border-redlog-border text-xs font-mono text-redlog-text-dim text-center">
          {t('timeline.help.footer')}
        </div>
      </div>
    </div>
  )
}
