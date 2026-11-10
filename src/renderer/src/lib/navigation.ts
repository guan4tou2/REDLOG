import type { SettingsPage } from '../components/Settings'

// A navigation target is a view id, or `settings/<page>` for one page of
// Settings. Settings used to open on its first page from every link, so
// "periodic capture settings" and the broken-chain issue both landed on Hooks.
//
// Two pages take a query: `scope` a `candidate` (a target to add), and
// `captureControl` a `source` — the capture health id of the row to land on
// (`agent-claude-code`, `screenshot`, `clipboard`, …). A warning about one
// source used to open the whole page and leave the operator to find it.

/** What a link may carry to the page it opens. */
interface SettingsTargetOptions { candidate?: string; source?: string }

/** Health ids are lowercase words joined by `-` or `.` (`<plugin>.<entry>`). */
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** The target that opens one Settings page. */
export function settingsTarget(page: SettingsPage, { candidate, source }: SettingsTargetOptions = {}): string {
  const query = new URLSearchParams()
  if (page === 'scope' && candidate) query.set('candidate', candidate)
  if (page === 'captureControl' && source && SOURCE_ID.test(source)) query.set('source', source)
  const text = query.toString()
  return `settings/${page}${text ? `?${text}` : ''}`
}

export function parseTarget(target: string): { view: string; settingsPage?: SettingsPage; scopeCandidate?: string; sourceId?: string } {
  const [view, rest] = target.split('/', 2)
  const [page, query] = (rest ?? '').split('?', 2)
  if (view !== 'settings' || !page) return { view }
  const params = new URLSearchParams(query)
  const candidate = page === 'scope' ? params.get('candidate')?.slice(0, 2048) : undefined
  const source = page === 'captureControl' ? params.get('source') : null
  return {
    view, settingsPage: page as SettingsPage,
    ...(candidate ? { scopeCandidate: candidate } : {}),
    ...(source && SOURCE_ID.test(source) ? { sourceId: source } : {})
  }
}
