import { Bot, Package, Puzzle, TriangleAlert, ChevronRight } from 'lucide-react'
import type { PluginKind, PluginTone, PluginView, PluginViewModel } from '../../lib/pluginViewModel'
import { pluginKind, pluginTone } from '../../lib/pluginViewModel'

type T = (key: string, vars?: Record<string, string | number>) => string

/** Literal keys, so the copy guard can see that each one is rendered. */
export const KIND_LABEL: Record<PluginKind, string> = {
  official: 'plugins.type.official',
  builtin: 'plugins.type.builtin',
  user: 'plugins.type.user'
}

export const TONE_DOT: Record<PluginTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-400',
  bad: 'bg-red-400',
  idle: 'bg-redlog-text-faint'
}

/** The plugin's mark. A fault replaces the kind's icon, so the row says so
 *  before anything is read. */
export function PluginIcon({ kind, tone, size = 18 }: { kind: PluginKind; tone: PluginTone; size?: number }): JSX.Element {
  const Icon = tone === 'bad' ? TriangleAlert : kind === 'official' ? Bot : kind === 'builtin' ? Package : Puzzle
  return <Icon size={size} strokeWidth={1.75} aria-hidden className={tone === 'bad' ? 'text-red-400' : 'text-redlog-text-dim'} />
}

/** One plugin in the list: the whole row opens its detail. Every control
 *  (enable, review, revoke) lives in the detail, so the list is only for
 *  finding and reading, and a row never offers a switch for something its
 *  diagnosis has not been read. */
export function PluginRow({ p, vm, t, description, onSelect }: {
  p: PluginView; vm: PluginViewModel; t: T; description: string; onSelect: () => void
}): JSX.Element {
  const kind = pluginKind(p)
  const tone = pluginTone(p)
  const issue = vm.issues[0]
  const official = vm.install.official
  return (
    <button
      type="button"
      data-testid={`plugin-details-${p.id}`}
      aria-label={p.name}
      onClick={onSelect}
      className={`group w-full text-left flex items-center justify-between gap-3 rounded border bg-redlog-surface/50 p-3 transition-colors hover:bg-redlog-elevated/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim ${tone === 'bad' ? 'border-red-500/40' : 'border-redlog-border'}`}
    >
      <span className="flex items-start gap-3 min-w-0">
        <span className="w-8 h-8 shrink-0 rounded border border-redlog-border bg-redlog-bg flex items-center justify-center">
          <PluginIcon kind={kind} tone={tone} />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-redlog-text">{p.name}</span>
            {p.version && <span className="text-xs font-mono text-redlog-text-dim">v{p.version}</span>}
            <span className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim">{t(KIND_LABEL[kind])}</span>
            <span data-testid={`plugin-state-${p.id}`} className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim">
              {vm.trust.applicable ? t(`plugins.status.${p.status}`) : t(`plugins.installState.${official?.state ?? 'not-installed'}`)}
            </span>
            {p.tier === 'privileged' && <span className="text-xs px-1.5 py-0.5 rounded bg-red-950/60 text-red-300">{t('plugins.tier.privileged')}</span>}
          </span>
          {issue && <span data-testid={`plugin-issue-${p.id}`} className="block text-xs text-amber-400 mt-0.5">{t(issue.labelKey)}</span>}
          <span title={description} className="block text-xs text-redlog-text-dim mt-0.5 line-clamp-1 break-words">{description}</span>
          <span className="flex items-center gap-1.5 mt-1 text-xs font-mono text-redlog-text-faint">
            <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[tone]}`} />
            <span className="break-all">{p.id}</span>
          </span>
        </span>
      </span>
      <ChevronRight size={18} aria-hidden className="shrink-0 text-redlog-text-faint group-hover:text-redlog-text" />
    </button>
  )
}
