import { app, dialog, shell } from 'electron'

// Lightweight update checker. Full auto-download+install (electron-updater) needs
// a code-signed build on macOS, which we don't ship, so instead we check the
// latest GitHub release and, when a newer version exists, offer to open the
// download page. Zero extra dependencies; works on every platform.

const OWNER = 'guan4tou2'
const REPO = 'REDLOG'
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`

function parseVer(v: string): number[] {
  return v.replace(/^v/, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0)
}

// True if `a` is a strictly newer version string than `b`.
function isNewer(a: string, b: string): boolean {
  const A = parseVer(a)
  const B = parseVer(b)
  const len = Math.max(A.length, B.length)
  for (let i = 0; i < len; i++) {
    const d = (A[i] || 0) - (B[i] || 0)
    if (d !== 0) return d > 0
  }
  return false
}

async function fetchLatest(): Promise<{ version: string; url: string } | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'RedLog', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    if (!res.ok) return null
    const data = (await res.json()) as { tag_name?: string; html_url?: string }
    if (!data.tag_name) return null
    return { version: data.tag_name.replace(/^v/, ''), url: data.html_url || RELEASES_PAGE }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Check GitHub for a newer release. Silent auto-checks only run in packaged
 * builds; a `manual` check (from the Settings button) also reports "up to date"
 * and connection failures.
 */
export async function checkForUpdates(opts: { manual?: boolean } = {}): Promise<void> {
  const manual = opts.manual ?? false
  if (!app.isPackaged && !manual) return

  const latest = await fetchLatest()
  if (!latest) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'warning', buttons: ['好'], title: '檢查更新',
        message: '無法連線檢查更新,請稍後再試。'
      })
    }
    return
  }

  if (isNewer(latest.version, app.getVersion())) {
    const detail = process.platform === 'darwin'
      ? 'macOS 版請前往下載頁手動更新(自動安裝需程式簽章)。'
      : '前往下載頁取得最新安裝檔。'
    const r = await dialog.showMessageBox({
      type: 'info', buttons: ['前往下載', '稍後'], defaultId: 0, cancelId: 1,
      title: '有新版本', message: `RedLog ${latest.version} 可用(目前 ${app.getVersion()})`, detail
    })
    if (r.response === 0) await shell.openExternal(latest.url)
  } else if (manual) {
    await dialog.showMessageBox({
      type: 'info', buttons: ['好'], title: '已是最新版',
      message: `RedLog ${app.getVersion()} 已是最新版本。`
    })
  }
}
