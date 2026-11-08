import { PAGE_COLUMN } from '../lib/pageColumn'
import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { useAppCounts } from '../lib/useAppCounts'
import { Button } from './Button'

type Page = 'targets' | 'scope'
const PAGES: Page[] = ['targets', 'scope']

/** What the page can say about the declared rules, and nothing it cannot: a
 *  failed read is its own state, never "not set" and never "in scope". */
async function loadRules(): Promise<{ allow: number; exclude: number }> {
  const c = await window.redlog.config.get() as { scope?: { targets?: string[]; excludeTargets?: string[] } } | null
  return { allow: c?.scope?.targets?.length ?? 0, exclude: c?.scope?.excludeTargets?.length ?? 0 }
}

function Dot({ tone }: { tone: 'good' | 'warn' }): JSX.Element {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone === 'good' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
}

/** Heading, the two pages as tabs with their counts, and the state of the scope
 *  rules, shared by Targets and Scope. Rules are edited in Settings, not here. */
export function TargetsScopeHeader({ page, onNavigate, onOpenSettings }: {
  page: Page
  onNavigate: (page: Page) => void
  onOpenSettings: () => void
}): JSX.Element {
  const { t } = useI18n()
  const { scopeObservations } = useAppCounts()
  const rules = useReadState(loadRules)
  const targetCount = useReadState(async () => (await window.redlog.events.aggregateTargets()).length)
  const { retry: retryRules } = rules
  const { retry: retryTargets } = targetCount
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onSaved = (): void => retryRules()
    window.addEventListener('redlog:config-saved', onSaved)
    // A new target appears while the page is open; one read per burst, not per batch.
    const unsub = window.redlog.events.onNewBatch((events) => {
      if (!events.some((e) => e.targetId || e.data?.detectedTarget)) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(retryTargets, 1500)
    })
    return () => { window.removeEventListener('redlog:config-saved', onSaved); unsub(); if (timer.current) clearTimeout(timer.current) }
  }, [retryRules, retryTargets])

  const value = rules.state.value
  const failed = rules.state.phase === 'failed' && !value
  const configured = !!value && (value.allow > 0 || value.exclude > 0)

  return <div data-testid="targets-scope-header" className="shrink-0 px-4 pt-4"><div className={`${PAGE_COLUMN} space-y-3`}>
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-redlog-text">{t('sidebar.targetsScope')}</h1>
        <p className="mt-1 text-xs text-redlog-text-dim">{t('targetsScope.hint')}</p>
      </div>
      <Button data-testid="targets-scope-settings" size="compact" onClick={onOpenSettings}>{t('targetsScope.openSettings')} ↗</Button>
    </div>
    <div role="tablist" aria-label={t('sidebar.targetsScope')} className="flex gap-4 border-b border-redlog-border">
      {PAGES.map((id, index) => {
        // Observations are judged against the rules: with none set, or none
        // readable, "0" would say "judged and clear". Say there is no count.
        const noCount = id === 'scope' && (failed || !configured)
        const count = id === 'targets' ? targetCount.state.value : scopeObservations
        const selected = page === id
        return <button key={id} type="button" role="tab" data-view-btn={id} aria-selected={selected} tabIndex={selected ? 0 : -1}
          onClick={() => onNavigate(id)}
          onKeyDown={(e) => {
            const next = e.key === 'ArrowRight' ? PAGES[(index + 1) % PAGES.length] : e.key === 'ArrowLeft' ? PAGES[(index + PAGES.length - 1) % PAGES.length] : undefined
            if (next) { e.preventDefault(); onNavigate(next); document.querySelector<HTMLButtonElement>(`button[role="tab"][data-view-btn="${next}"]`)?.focus() }
          }}
          className={`px-1 py-2 text-sm border-b-2 ${selected ? 'border-redlog-accent text-redlog-text' : 'border-transparent text-redlog-text-dim hover:text-redlog-text'}`}>
          {t(id === 'targets' ? 'sidebar.targets' : 'targetsScope.scopeTab')}
          {noCount
            ? <span data-testid={`tab-count-${id}`} aria-label={t('targetsScope.noCount')} className="ml-1.5 font-mono text-xs text-redlog-text-faint">—</span>
            : typeof count === 'number' && <span data-testid={`tab-count-${id}`} className={`ml-1.5 font-mono text-xs tabular-nums ${selected ? 'text-redlog-accent' : 'text-redlog-text-faint'}`}>{count}</span>}
        </button>
      })}
    </div>
    <section data-testid="scope-context" role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-redlog-border bg-redlog-surface px-4 py-3">
      <div className="min-w-[14rem] flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-redlog-text">
          <Dot tone={configured ? 'good' : 'warn'} />
          {failed ? t('targetsScope.failedTitle') : configured ? t('targetsScope.configuredTitle') : t('targetsScope.unsetTitle')}
        </p>
        <p className="mt-0.5 text-xs text-redlog-text-dim">
          {failed ? t('targetsScope.failedBody') : configured ? t('targetsScope.configuredBody') : t('targetsScope.unsetBody')}
        </p>
      </div>
      {configured && value && <>
        <span className="rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-xs text-redlog-text-dim">{t('targetsScope.allow')} <b className="font-mono text-redlog-text">{value.allow}</b></span>
        <span className="rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-xs text-redlog-text-dim">{t('targetsScope.exclude')} <b className="font-mono text-redlog-text">{value.exclude}</b></span>
      </>}
      {failed && <Button size="compact" data-testid="scope-context-retry" onClick={retryRules}>{t('common.retry')}</Button>}
      {!failed && !configured && value && <Button size="compact" onClick={onOpenSettings}>{t('targetsScope.goSettings')}</Button>}
    </section>
  </div></div>
}
