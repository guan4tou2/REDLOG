import { useState, useRef, useEffect } from 'react'
import { Download, ChevronDown } from 'lucide-react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { toast } from './Toast'
import { useViewExport } from '../lib/exportScope'

// One export control (docs/UIUX-STANDARD.md §10).
//
// Exporting was reachable from six places — the dashboard, three separate
// groups in Settings, the transcript's own button, and the timeline's slice
// button — each with its own wording and its own idea of what "export" meant.
// An operator writing an engagement up had to already know which of the six
// produced the thing they wanted.
//
// The scope of an export is a property of the export, not of where the button
// happens to live, so it becomes an option rather than a location: everything,
// what is currently on screen, or the visible time slice. Each option says
// what it will produce before it produces it — a wrong export is not a
// disaster, but discovering it was wrong after opening the file is a wasted
// round trip during the one task this record exists for.
//
// The evidence bundle stays, at the bottom, separated. It is a different kind
// of thing — a signed archive with a verifier for someone challenging the
// record — and after the 2026-08-21 core revision that is the exceptional
// path, not the everyday one (see DESIGN-core-and-capture.md §1).

export type ExportScope = 'all' | 'view' | 'slice'
export type ExportFormat = 'json' | 'markdown'

export interface ExportMenuProps {
  /** How many events "everything" would carry, for the preview line. */
  totalCount?: number
}

/** Rough bytes per exported event. Deliberately approximate — the preview
 *  exists to catch "I meant the slice, not all 28,000", which a rounded
 *  megabyte answers just as well as an exact one. */
const BYTES_PER_EVENT = 520

function humanSize(events: number): string {
  const bytes = events * BYTES_PER_EVENT
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ExportMenu({ totalCount }: ExportMenuProps): JSX.Element {
  const { t } = useI18n()
  // Whatever the view on screen contributed, if anything.
  const viewExport = useViewExport()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const run = async (label: string, fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    try {
      const path = await fn()
      if (path) toast(t('export.done', { label }), { type: 'success', why: path })
      else toast(t('export.failed', { label }), { type: 'error', why: t('toast.exportFailedWhy') })
    } catch (e) {
      toast(t('export.failed', { label }), {
        type: 'error',
        why: t('toast.exportFailedWhy'),
        detail: String((e as Error)?.message ?? e)
      })
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  const Option = ({ label, count, onPick }: {
    label: string; count?: number; onPick: () => void
  }): JSX.Element => (
    <button
      onClick={onPick}
      disabled={busy}
      className="w-full text-left px-3 py-2 hover:bg-redlog-elevated focus-visible:outline-none focus-visible:bg-redlog-elevated disabled:opacity-40"
    >
      <span className="block text-xs text-redlog-text">{label}</span>
      {typeof count === 'number' && (
        <span className="block text-xs text-redlog-text-faint tabular-nums">
          {t('export.preview', { count, size: humanSize(count) })}
        </span>
      )}
    </button>
  )

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('export.title')}
        className="flex items-center gap-1 px-2 h-6 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-accent/50"
      >
        <Download size={13} strokeWidth={1.5} aria-hidden />
        {t('export.title')}
        <ChevronDown size={12} strokeWidth={1.5} aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
          <div
            ref={panel}
            role="menu"
            aria-label={t('export.title')}
            className="absolute right-0 top-7 z-[91] w-[280px] bg-redlog-surface border border-redlog-border rounded-lg shadow-2xl overflow-hidden py-1"
          >
            {viewExport && (
              <Option
                label={viewExport.label}
                count={viewExport.count}
                onPick={() => void run(viewExport.label, viewExport.run)}
              />
            )}
            <Option
              label={t('export.all')}
              count={totalCount}
              onPick={() => void run(t('export.all'), () => window.redlog.data.exportJson())}
            />

            <div className="border-t border-redlog-border my-1" />
            {/* Separated: a signed archive for someone challenging the record
                is a different errand from taking the log away to write up. */}
            <Option
              label={t('export.bundle')}
              onPick={() => void run(t('export.bundle'), async () => {
                const api = window.redlog.data as { exportBundle?: () => Promise<{ ok: boolean; zipPath?: string }> }
                if (!api.exportBundle) return null
                const r = await api.exportBundle()
                return r.ok ? (r.zipPath ?? null) : null
              })}
            />
          </div>
        </>
      )}
    </div>
  )
}
