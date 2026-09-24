// Spec 036: the first-launch readiness card is shown once per install. The
// "seen" flag is a per-viewer convenience, so it lives in localStorage — and
// storage can be missing or throw, in which case the card simply shows again.

const SEEN_KEY = 'redlog-runtime-readiness-seen'
const OPEN_EVENT = 'redlog:open-runtime-readiness'

export function readinessSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}

export function markReadinessSeen(): void {
  try { localStorage.setItem(SEEN_KEY, '1') } catch { /* storage unavailable */ }
}

/** Reopen the readiness card from anywhere (Capture Health links here). */
export function openRuntimeReadiness(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function onOpenRuntimeReadiness(cb: () => void): () => void {
  window.addEventListener(OPEN_EVENT, cb)
  return () => window.removeEventListener(OPEN_EVENT, cb)
}

/** `/home/op/.zshrc` → `~/.zshrc`, for display only. */
export function tildePath(file: string): string {
  return file.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\])/, '~')
}
