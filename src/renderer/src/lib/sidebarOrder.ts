// Shared source of truth for the sidebar item order + persistence, imported
// by BOTH Sidebar (renders + drag-reorders) and App (⌘1..9 shortcuts). Prior
// to this both maintained their own hardcoded arrays that drifted whenever
// Sidebar was reshuffled (v0.6.18 moved Timeline to slot 2 in the sidebar
// but ⌘2 still jumped to Terminal — audit finding P0 #8).
//
// Settings is intentionally NOT in DEFAULT_ORDER — it's pinned at the bottom
// of Sidebar and doesn't participate in drag-reorder. Callers that want a
// full nav order for keyboard shortcuts should append 'settings' themselves.

export type SidebarViewId =
  | 'dashboard' | 'timeline' | 'transcript' | 'terminal' | 'screenshots'
  | 'targets' | 'scope' | 'loot' | 'marks' | 'http_history'

export const STORAGE_KEY = 'redlog-sidebar-order-v2'
// v0.11.2: `transcript` sits next to `timeline` — same events, read the other
// way. loadSidebarOrder() rejects a saved list whose length no longer matches,
// so existing installs fall back to this order once and keep their new one.
export const DEFAULT_ORDER: SidebarViewId[] = [
  'dashboard', 'timeline', 'transcript', 'http_history', 'terminal', 'screenshots', 'targets', 'scope', 'loot', 'marks'
]

/** Read the persisted order, falling back to DEFAULT_ORDER if missing or
 *  corrupt. Rejects reordered lists that lost or gained items compared to
 *  the current defaults — that means the list schema evolved and the saved
 *  order is no longer valid. */
export function loadSidebarOrder(): SidebarViewId[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return DEFAULT_ORDER
    const parsed = JSON.parse(saved) as string[]
    if (!Array.isArray(parsed)) return DEFAULT_ORDER
    const hasAllItems = DEFAULT_ORDER.every((id) => parsed.includes(id))
    if (!hasAllItems || parsed.length !== DEFAULT_ORDER.length) return DEFAULT_ORDER
    return parsed as SidebarViewId[]
  } catch { return DEFAULT_ORDER }
}

export function saveSidebarOrder(order: SidebarViewId[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)) } catch { /* quota — ignore */ }
  // Same-tab listeners don't get the standard 'storage' event; fire a custom
  // one so App.tsx's ⌘1..9 handler picks up the new order without needing a
  // page reload. Cross-tab (unused here — Electron single-window) still gets
  // the native event.
  try { window.dispatchEvent(new CustomEvent('redlog:sidebar-order-changed')) } catch { /* ignore */ }
}

/** Subscribe to persisted-order changes — both same-tab (custom event, above)
 *  and cross-tab (native `storage`). Returns an unsubscribe. */
export function onSidebarOrderChanged(cb: () => void): () => void {
  const handler = (): void => cb()
  window.addEventListener('redlog:sidebar-order-changed', handler)
  const storageHandler = (e: StorageEvent): void => { if (e.key === STORAGE_KEY) cb() }
  window.addEventListener('storage', storageHandler)
  return () => {
    window.removeEventListener('redlog:sidebar-order-changed', handler)
    window.removeEventListener('storage', storageHandler)
  }
}
