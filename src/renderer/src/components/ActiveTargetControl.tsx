import { useEffect, useState } from 'react'
import { Crosshair, X } from 'lucide-react'
import { useI18n } from '../i18n'

export function ActiveTargetControl(): JSX.Element {
  const [active, setActive] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [known, setKnown] = useState<string[]>([])
  const { t } = useI18n()

  useEffect(() => {
    const loadKnown = async (): Promise<void> => {
      const [rows, config] = await Promise.all([
        window.redlog.events.aggregateTargets(),
        window.redlog.config.get()
      ])
      const scope = (config as { scope?: { targets?: string[] } } | null)?.scope?.targets ?? []
      setKnown([...new Set([...scope, ...rows.map((row) => row.target)])].sort())
    }
    void window.redlog.targetContext.get().then((target) => { setActive(target); setDraft(target ?? '') })
    void loadKnown().catch(() => {})
    const offTarget = window.redlog.targetContext.onChange((target) => { setActive(target); setDraft(target ?? '') })
    const offEvents = window.redlog.events.onNewBatch((events) => {
      const additions = events.map((event) => event.targetId).filter((target): target is string => !!target)
      if (additions.length) setKnown((current) => [...new Set([...current, ...additions])].sort())
    })
    return () => { offTarget(); offEvents() }
  }, [])

  const commit = async (value: string): Promise<void> => {
    const target = value.trim() || null
    const result = await window.redlog.targetContext.set(target)
    if (!result.ok) { setDraft(active ?? ''); return }
    setActive(result.target)
    setDraft(result.target ?? '')
  }

  return (
    <div
      className="ml-3 flex items-center gap-1 text-xs"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={t('activeTarget.hint')}
    >
      <Crosshair size={13} className={active ? 'text-redlog-accent' : 'text-redlog-text-faint'} aria-hidden />
      <label htmlFor="active-target-input" className="sr-only">{t('activeTarget.label')}</label>
      <input
        id="active-target-input"
        data-testid="active-target-input"
        list="active-target-options"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void commit(draft); event.currentTarget.blur() }
          if (event.key === 'Escape') { setDraft(active ?? ''); event.currentTarget.blur() }
        }}
        onBlur={() => { if (draft.trim() !== (active ?? '')) void commit(draft) }}
        placeholder={t('activeTarget.none')}
        className="w-40 rounded border border-redlog-border bg-redlog-surface px-2 py-0.5 font-mono text-redlog-text placeholder-redlog-text-faint focus:border-redlog-accent focus:outline-none"
      />
      <datalist id="active-target-options">
        {known.map((target) => <option key={target} value={target} />)}
      </datalist>
      {active && (
        <button
          type="button"
          onClick={() => void commit('')}
          aria-label={t('activeTarget.clear')}
          title={t('activeTarget.clear')}
          className="rounded p-0.5 text-redlog-text-faint hover:bg-white/10 hover:text-redlog-text"
        ><X size={12} aria-hidden /></button>
      )}
    </div>
  )
}
