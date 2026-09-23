// The proxied capture browser's settings and their defaults — one copy for the
// config defaults, the launcher and the Settings page.
//
// No imports: the renderer bundles this file.

export interface BrowserConfig {
  binary: string        // '' = auto-detect
  proxy: string         // e.g. http://127.0.0.1:8080 — '' disables the flag
  cdpPort: number       // remote debugging port, so Bookmarks can read the tab
  isolateProfile: boolean
  ignoreCertErrors: boolean
  startUrl: string
  extraArgs: string[]
}

export const DEFAULT_BROWSER: Readonly<BrowserConfig> = Object.freeze({
  binary: '',
  proxy: 'http://127.0.0.1:8080',
  cdpPort: 9222,
  isolateProfile: true,
  ignoreCertErrors: true,
  startUrl: '',
  extraArgs: []
})
