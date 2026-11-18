// After the palette opens a Settings page for a search hit, bring the matching
// field into view and mark it briefly — what the Settings home does for its own
// search results. The page mounts after the navigation, so this waits for it,
// and gives up quietly after a few seconds: the operator is then on the right
// page, just not scrolled to the line.

const GIVE_UP_MS = 4000

export function landOnSetting(page: string, key: string, text: string): void {
  const locate = (): boolean => {
    const root = document.querySelector<HTMLElement>('[data-testid="settings-content"]')
    if (!root || root.dataset.page !== page) return false
    const el = root.querySelector<HTMLElement>(`[data-settings-key="${CSS.escape(key)}"]`)
      ?? Array.from(root.querySelectorAll<HTMLElement>('h3, label, p, span, button'))
        .find((e) => e.textContent?.includes(text))
    if (!el) return false
    el.scrollIntoView?.({ block: 'center' })
    el.classList.add('ring-1', 'ring-redlog-accent', 'rounded')
    setTimeout(() => el.classList.remove('ring-1', 'ring-redlog-accent', 'rounded'), 1600)
    return true
  }
  if (locate()) return
  const observer = new MutationObserver(() => { if (locate()) observer.disconnect() })
  observer.observe(document.body, { childList: true, subtree: true })
  setTimeout(() => observer.disconnect(), GIVE_UP_MS)
}
