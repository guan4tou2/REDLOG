import { app, dialog, shell, BrowserWindow } from 'electron'
import { anchorBeforeRestart } from '../../core/update-anchor'

// Windows: in-app auto-download+install via electron-updater (NSIS works
// unsigned). macOS/Linux: open the GitHub releases page — macOS auto-update
// needs code signing we don't ship, and Linux packages update through their
// own package manager or manual replacement.

const OWNER = 'guan4tou2'
const REPO = 'REDLOG'
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`

function parseVer(v: string): number[] {
  return v.replace(/^v/, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0)
}

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

const TAG = '[updater]'

async function fetchLatest(): Promise<{ version: string; url: string } | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'RedLog', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    if (!res.ok) {
      console.warn(TAG, `GitHub API responded ${res.status}`)
      return null
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string }
    if (!data.tag_name) return null
    const ver = data.tag_name.replace(/^v/, '')
    console.log(TAG, `latest release: ${ver}`)
    return { version: ver, url: data.html_url || RELEASES_PAGE }
  } catch (e) {
    console.warn(TAG, 'fetch failed:', (e as Error).message)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Windows in-app updater (electron-updater)
// ---------------------------------------------------------------------------
let winUpdaterReady = false

function setupWindowsUpdater(): void {
  if (winUpdaterReady || process.platform !== 'win32') return

  // Lazy-import so macOS/Linux never load the module.
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log(TAG, ...args),
    warn: (...args: unknown[]) => console.warn(TAG, ...args),
    error: (...args: unknown[]) => console.error(TAG, ...args),
    debug: (...args: unknown[]) => console.log(TAG, '[debug]', ...args)
  }
  winUpdaterReady = true
  console.log(TAG, 'electron-updater initialised (win32)')
}

// Runs the full check→prompt→download→install flow on Windows.
// Returns true if it handled the flow (even "no update"), false to fall back.
async function windowsAutoUpdate(manual: boolean): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    setupWindowsUpdater()
  } catch (e) {
    console.error(TAG, 'electron-updater setup failed, falling back to browser:', (e as Error).message)
    return false
  }

  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')

  let result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  try {
    console.log(TAG, 'checking for updates via electron-updater…')
    result = await autoUpdater.checkForUpdates()
  } catch (e) {
    console.error(TAG, 'checkForUpdates failed:', (e as Error).message)
    if (manual) {
      await dialog.showMessageBox({
        type: 'warning', buttons: ['好'], title: '檢查更新',
        message: '無法連線檢查更新，請稍後再試。'
      })
    }
    return true
  }

  if (!result || !result.updateInfo) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info', buttons: ['好'], title: '已是最新版',
        message: `RedLog ${app.getVersion()} 已是最新版本。`
      })
    }
    return true
  }

  const remoteVer = result.updateInfo.version
  console.log(TAG, `remote=${remoteVer} local=${app.getVersion()}`)
  if (!isNewer(remoteVer, app.getVersion())) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info', buttons: ['好'], title: '已是最新版',
        message: `RedLog ${app.getVersion()} 已是最新版本。`
      })
    }
    return true
  }

  // Ask the user whether to download.
  const ask = await dialog.showMessageBox({
    type: 'info',
    buttons: ['下載並安裝', '稍後'],
    defaultId: 0,
    cancelId: 1,
    title: '有新版本',
    message: `RedLog ${remoteVer} 可用（目前 ${app.getVersion()}）`,
    detail: '下載完成後將自動安裝並重新啟動。'
  })
  if (ask.response !== 0) {
    console.log(TAG, 'user deferred update')
    return true
  }

  console.log(TAG, `downloading ${remoteVer}…`)
  // Show a progress dialog while downloading.
  const progressWin = new BrowserWindow({
    width: 400, height: 130,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  progressWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px;
         background: #1e1e2e; color: #cdd6f4; user-select: none; }
  h3 { margin: 0 0 12px; font-size: 14px; font-weight: 500; }
  .bar { height: 6px; background: #313244; border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; background: #89b4fa; width: 0%; transition: width 0.2s; border-radius: 3px; }
  .pct { margin-top: 8px; font-size: 12px; color: #a6adc8; }
</style></head><body>
  <h3 id="t">正在下載 RedLog ${remoteVer}…</h3>
  <div class="bar"><div class="fill" id="f"></div></div>
  <div class="pct" id="p">0%</div>
  <script>
    window.setProgress = (pct) => {
      document.getElementById('f').style.width = pct + '%';
      document.getElementById('p').textContent = Math.round(pct) + '%';
    };
    window.setDone = () => {
      document.getElementById('t').textContent = '下載完成，正在安裝…';
      document.getElementById('p').textContent = '';
      document.getElementById('f').style.width = '100%';
    };
  </script>
</body></html>`)}`)

  autoUpdater.on('download-progress', (info) => {
    if (!progressWin.isDestroyed()) {
      progressWin.webContents.executeJavaScript(`window.setProgress(${info.percent})`)
    }
  })

  try {
    await autoUpdater.downloadUpdate()
    console.log(TAG, 'download complete')
  } catch (e) {
    console.error(TAG, 'download failed:', (e as Error).message)
    if (!progressWin.isDestroyed()) progressWin.destroy()
    await dialog.showMessageBox({
      type: 'error', buttons: ['好'], title: '更新失敗',
      message: '下載更新失敗，請稍後再試或前往 GitHub 手動下載。'
    })
    return true
  }

  if (!progressWin.isDestroyed()) {
    progressWin.webContents.executeJavaScript('window.setDone()')
  }

  // Anchor the chain head before quit-and-install.
  try {
    await anchorBeforeRestart({ fromVersion: app.getVersion(), toVersion: remoteVer })
    console.log(TAG, 'chain head anchored before restart')
  } catch (e) {
    console.warn(TAG, 'anchor failed (best-effort):', (e as Error).message)
  }

  // Small delay so the user sees "installing…"
  await new Promise((r) => setTimeout(r, 800))
  if (!progressWin.isDestroyed()) progressWin.destroy()

  console.log(TAG, 'quitting to install…')
  autoUpdater.quitAndInstall(false, true)
  return true
}

// ---------------------------------------------------------------------------
// macOS / Linux: open-browser fallback (original behaviour)
// ---------------------------------------------------------------------------
async function browserFallbackUpdate(manual: boolean): Promise<void> {
  console.log(TAG, 'using browser fallback path')
  const latest = await fetchLatest()
  if (!latest) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'warning', buttons: ['好'], title: '檢查更新',
        message: '無法連線檢查更新，請稍後再試。'
      })
    }
    return
  }

  if (isNewer(latest.version, app.getVersion())) {
    const detail = process.platform === 'darwin'
      ? 'macOS 版請前往下載頁手動更新（自動安裝需程式簽章）。'
      : '前往下載頁取得最新安裝檔。'
    const r = await dialog.showMessageBox({
      type: 'info', buttons: ['前往下載', '稍後'], defaultId: 0, cancelId: 1,
      title: '有新版本', message: `RedLog ${latest.version} 可用（目前 ${app.getVersion()}）`, detail
    })
    if (r.response === 0) {
      try {
        await anchorBeforeRestart({ fromVersion: app.getVersion(), toVersion: latest.version })
      } catch { /* best-effort */ }
      console.log(TAG, `opening release page: ${latest.url}`)
      await shell.openExternal(latest.url)
    }
  } else if (manual) {
    await dialog.showMessageBox({
      type: 'info', buttons: ['好'], title: '已是最新版',
      message: `RedLog ${app.getVersion()} 已是最新版本。`
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
let airgap = false
export function setUpdaterAirgap(v: boolean): void { airgap = v }

export async function checkForUpdates(opts: { manual?: boolean } = {}): Promise<void> {
  if (airgap) {
    console.log(TAG, 'skipped (air-gap mode)')
    if (opts.manual) {
      try {
        const { dialog } = await import('electron')
        await dialog.showMessageBox({ type: 'info', message: 'Update check is disabled in air-gap mode.', detail: 'Turn off Settings ▸ Network ▸ Air-gap to check for updates.' })
      } catch { /* no window */ }
    }
    return
  }
  const manual = opts.manual ?? false
  if (!app.isPackaged && !manual) {
    console.log(TAG, 'skipped (not packaged, non-manual)')
    return
  }
  console.log(TAG, `check starting (manual=${manual}, platform=${process.platform})`)

  // Windows: in-app download+install. Falls back to browser on failure.
  if (process.platform === 'win32') {
    const handled = await windowsAutoUpdate(manual)
    if (handled) return
  }

  // macOS / Linux / Windows fallback
  await browserFallbackUpdate(manual)
}
