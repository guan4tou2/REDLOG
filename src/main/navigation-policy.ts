// The app is a single-page app and never navigates. A file dropped on a screen
// with no drop handler, or a link in captured evidence, must not replace the
// page that holds the preload bridge. Only two navigations are legitimate: a
// reload of the page already loaded (palette project switch, dev HMR full
// reload) and the dev server origin in dev.
export function allowNavigation(targetUrl: string, currentUrl: string, devUrl?: string): boolean {
  if (targetUrl === currentUrl) return true
  const stripHash = (u: string): string => u.split('#')[0]
  if (currentUrl && stripHash(targetUrl) === stripHash(currentUrl)) return true
  if (devUrl) {
    try {
      const dev = new URL(devUrl)
      const target = new URL(targetUrl)
      if (target.origin === dev.origin && (target.protocol === 'http:' || target.protocol === 'https:')) return true
    } catch { /* unparsable URL: deny */ }
  }
  return false
}
