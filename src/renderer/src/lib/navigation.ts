import type { SettingsPage } from '../components/Settings'

// A navigation target is a view id, or `settings/<page>` for one page of
// Settings. Settings used to open on its first page from every link, so
// "periodic capture settings" and the broken-chain issue both landed on Hooks.

/** The target that opens one Settings page. */
export function settingsTarget(page: SettingsPage): string {
  return `settings/${page}`
}

export function parseTarget(target: string): { view: string; settingsPage?: SettingsPage } {
  const [view, page] = target.split('/', 2)
  return view === 'settings' && page ? { view, settingsPage: page as SettingsPage } : { view }
}
