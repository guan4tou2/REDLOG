import { HEADER_GUTTER, PAGE_BODY } from '../lib/pageLayout'
import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { useAppCounts } from '../lib/useAppCounts'
import { scopeConfigured } from '../lib/scope'
import { Button } from './Button'

type Page = 'targets' | 'scope'
const PAGES: Page[] = ['targets', 'scope']

/** What the page can say about the declared rules, and nothing it cannot: a
 *  failed read is its own state, never "not set" and never "in scope". */
async function loadRules(): Promise<{ allow: string[]; exclude: string[]; configured: boolean }> {
  const c = await window.redlog.config.get() as { scope?: { targets?: string[]; excludeTargets?: string[] } } | null
  return { allow: c?.scope?.targets ?? [], exclude: c?.scope?.excludeTargets ?? [], configured: scopeConfigured(c?.scope) }
}

/** How many rules the card shows before it says how many more there are. */
const RULES_SHOWN = 6

/** The declared rules themselves. An excluded one is marked by "!" and by its
 *  word, not by colour alone. Edited in Settings, not here. */
function RuleList({ allow, exclude }: { allow: string[]; exclude: string[] }): JSX.Element | null {
  const { t } = useI18n()
  const all = [...allow.map((rule) => ({ rule, kind: 'allow' as const })), ...exclude.map((rule) => ({ rule, kind: 'exclude' as const }))]
  if (all.length === 0) return null
  const more = all.length - RULES_SHOWN
  return <ul className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-4 gap-y-0.5 font-mono text-xs">
    {all.slice(0, RULES_SHOWN).map(({ rule, kind }) => (
      <li key={`${kind}:${rule}`} data-testid="scope-rule" data-kind={kind} data-rule={rule} className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
        {kind === 'exclude' && <span aria-hidden="true" className="text-amber-300">!</span>}
        <span title={rule} className={`min-w-0 overflow-hidden text-ellipsis ${kind === 'exclude' ? 'text-redlog-text-dim' : 'text-redlog-text'}`}>{rule}</span>
        {kind === 'exclude' && <span className="font-sans text-redlog-text-faint">{t('targetsScope.exclude')}</span>}
      </li>
    ))}
    {more > 0 && <li data-testid="scope-rules-more" className="font-sans text-redlog-text-faint">{t('targetsScope.moreRules', { count: more })}</li>}
  </ul>
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
  // Core's rule: exclusions alone are not a scope. They are still listed, as
  // a fact, under "not set".
  const configured = !!value && value.configured

  return <div data-testid="targets-scope-header" className="flex shrink-0 px-pad pt-3"><div className={`${PAGE_BODY} flex-1 space-y-3`}>
    <h1 className="min-w-0 text-lg font-semibold text-redlog-text">{t('sidebar.targetsScope')}</h1>
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
    <section data-testid="scope-context" role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-redlog-border bg-redlog-surface px-4 py-3">
      <div className="min-w-[14rem] flex-1">
        {/* Nothing until the first read answers: "not set" is a reading too. */}
        {(failed || value) && <p className="flex items-center gap-2 text-sm font-medium text-redlog-text">
          <Dot tone={configured ? 'good' : 'warn'} />
          {failed ? t('targetsScope.failedTitle') : configured ? t('targetsScope.configuredTitle') : t('targetsScope.unsetTitle')}
        </p>}
        {/* Set, the rules say it; not set and unreadable are said in words,
            and are not the same thing. */}
        {failed && <p className="mt-0.5 text-xs text-redlog-text-dim">{t('targetsScope.failedBody')}</p>}
        {!failed && value && !configured && <p className="mt-0.5 text-xs text-redlog-text-dim">{t('targetsScope.unsetBody')}</p>}
        {!failed && value && <RuleList allow={value.allow} exclude={value.exclude} />}
      </div>
      {failed && <Button size="compact" data-testid="scope-context-retry" onClick={retryRules}>{t('common.retry')}</Button>}
      {/* The page's one way to Settings, where the rules are edited. */}
      <Button data-testid="targets-scope-settings" size="compact" onClick={onOpenSettings}>{t('targetsScope.openSettings')} ↗</Button>
    </section>
  </div>
    {/* The page below keeps a scrollbar gutter; this keeps the same one. */}
    <span aria-hidden data-scroll-gutter className={HEADER_GUTTER} />
  </div>
}
