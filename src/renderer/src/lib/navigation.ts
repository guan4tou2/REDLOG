import type { SettingsPage } from '../components/Settings'

// A navigation target is a view id, or `settings/<page>` for one page of
// Settings. Settings used to open on its first page from every link, so
// "periodic capture settings" and the broken-chain issue both landed on Hooks.

/** The target that opens one Settings page. */
export function settingsTarget(page: SettingsPage, candidate?: string): string {
  return `settings/${page}${page === 'scope' && candidate ? `?candidate=${encodeURIComponent(candidate)}` : ''}`
}

export function parseTarget(target: string): { view: string; settingsPage?: SettingsPage; scopeCandidate?: string } {
  const [view, rest] = target.split('/', 2)
  const [page, query] = (rest ?? '').split('?', 2)
  const candidate = page === 'scope' ? new URLSearchParams(query).get('candidate')?.slice(0, 2048) : undefined
  return view === 'settings' && page ? { view, settingsPage: page as SettingsPage, ...(candidate ? { scopeCandidate: candidate } : {}) } : { view }
}
