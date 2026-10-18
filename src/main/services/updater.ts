import { app, dialog, shell } from 'electron'
import { anchorBeforeRestart } from '../../core/update-anchor'
import { allowQuit, quitDialog, defaultQuitText, type QuitImpact } from '../quit-guard'
import { UpdateFlow } from './update-flow'

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

// What a restart would end right now, supplied by the main process so the
// answer is read when it is asked for (Spec 061 FR-005).
let impactProvider: () => QuitImpact | null = () => null
export function setUpdateImpactProvider(fn: () => QuitImpact | null): void { impactProvider = fn }

const zh = (): boolean => app.getLocale().toLowerCase().startsWith('zh')

let flow: UpdateFlow | null = null
function getFlow(autoUpdater: typeof import('electron-updater').autoUpdater): UpdateFlow {
  if (flow) return flow
  flow = new UpdateFlow({
    port: {
      download: async () => { await autoUpdater.downloadUpdate() },
      quitAndInstall: () => autoUpdater.quitAndInstall(false, true)
    },
    askDownload: async (version) => (await dialog.showMessageBox({
      type: 'info',
      buttons: zh() ? ['下載', '稍後'] : ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: zh() ? '有新版本' : 'Update available',
      message: zh()
        ? `RedLog ${version} 可用（目前 ${app.getVersion()}）`
        : `RedLog ${version} is available (you have ${app.getVersion()})`,
      detail: zh()
        ? '下載在背景進行，擷取不受影響。下載完成後不會自動重新啟動，由你決定何時安裝。'
        : 'The download runs in the background and recording is not affected. It will not restart on its own; you choose when to install.'
    })).response === 0,
    announceReady: async (version) => (await dialog.showMessageBox({
      type: 'info',
      buttons: zh() ? ['稍後', '安裝並重新啟動'] : ['Later', 'Install and restart'],
      defaultId: 0,
      cancelId: 0,
      title: zh() ? '更新已準備完成' : 'Update ready',
      message: zh() ? `RedLog ${version} 已下載完成` : `RedLog ${version} is downloaded`,
      detail: zh()
        ? '擷取仍在進行，不會自動重新啟動。之後可在「關於」按「檢查更新」再安裝。'
        : 'Recording continues and nothing restarts by itself. Install later from About ▸ Check for updates.'
    })).response === 1 ? 'now' : 'later',
    impact: () => impactProvider(),
    confirmRestart: async (impact, version) => {
      // The list of what stops is the quit dialog's own, so the two never
      // describe the same restart differently.
      const lines = quitDialog(impact, defaultQuitText(app.getLocale())).detail
      return (await dialog.showMessageBox({
        type: 'question',
        buttons: zh() ? ['稍後', '停止並更新'] : ['Later', 'Stop and update'],
        defaultId: 0,
        cancelId: 0,
        title: zh() ? '安裝更新並重新啟動？' : 'Install the update and restart?',
        message: impact.project
          ? `${impact.project}\n\n${zh() ? `重新啟動到 RedLog ${version} 會停止：` : `Restarting into RedLog ${version} stops:`}`
          : (zh() ? `重新啟動到 RedLog ${version} 會停止：` : `Restarting into RedLog ${version} stops:`),
        detail: lines
      })).response === 1
    },
    onDownloadFailed: async (error) => {
      console.error(TAG, 'download failed:', error.message)
      await dialog.showMessageBox({
        type: 'error',
        buttons: [zh() ? '好' : 'OK'],
        title: zh() ? '更新失敗' : 'Update failed',
        message: zh()
          ? '下載更新失敗。目前版本照常運作，可稍後再試或前往 GitHub 手動下載。'
          : 'The download failed. The current version keeps working; try again later or download it from GitHub.'
      })
    },
    beforeRestart: async (version) => {
      // Anchor the chain head before quit-and-install.
      try {
        await anchorBeforeRestart({ fromVersion: app.getVersion(), toVersion: version })
        console.log(TAG, 'chain head anchored before restart')
      } catch (e) {
        console.warn(TAG, 'anchor failed (best-effort):', (e as Error).message)
      }
    },
    allowQuit
  })
  autoUpdater.on('download-progress', (info) => console.log(TAG, `downloading… ${Math.round(info.percent)}%`))
  return flow
}

// Windows: check → ask → download in the background → say "ready". Restarting
// is a separate step the operator takes (see update-flow.ts).
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

  // Already downloaded, or being downloaded: do not check again. A ready update
  // goes straight to the restart question, which is how "later" is found again.
  const current = flow?.status().state
  if (current === 'downloading' || current === 'installing') return true
  if (current === 'ready') { await flow!.install(); return true }

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

  await getFlow(autoUpdater).offer(remoteVer)
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
        // No Settings control exists for this; the key is only in config.yaml.
        await dialog.showMessageBox({ type: 'info', message: 'Update check is disabled in air-gap mode.', detail: "Air-gap is set by network.offline in this project's config.yaml. Set it to false to check for updates." })
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
