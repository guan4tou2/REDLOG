import { ipcMain, shell, systemPreferences } from 'electron'
import { isOnPath } from '../../core/command-lookup'
import { configureCapturePrerequisites, type CapturePrerequisite } from '../../core/capture-health'

// What the OS has to allow, or have installed, before a capture source can
// record (#688). A source whose prerequisite is `missing` cannot record no
// matter how it is configured, and the operator is the only one who can fix
// it — so the health row says which one and offers the fix.
//
// `unknown` is "could not ask", never "missing": it is never shown as a fault.
// The probes are pure over their inputs; `installCapturePrerequisites` binds
// them to the running process.

/** What `systemPreferences.getMediaAccessStatus` answers. */
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

/** The one pane the renderer may ask main to open. Exact match only. */
export const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const OPENABLE = new Set([SCREEN_RECORDING_PANE])

export function screenRecordingPrerequisite(opts: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Null when the status could not be read. Called on macOS only. */
  readStatus: () => MediaAccessStatus | string | null
}): CapturePrerequisite {
  const id = 'screen-recording'
  if (opts.platform === 'darwin') {
    const status = opts.readStatus()
    if (status === 'granted') return { id, state: 'granted' }
    // Denied: desktopCapturer still answers, with the wallpaper and no
    // windows, which looks like a screenshot and is not one.
    if (status === 'denied' || status === 'restricted') {
      return { id, state: 'missing', fix: { kind: 'open', url: SCREEN_RECORDING_PANE } }
    }
    // not-determined: the first capture raises the OS prompt.
    return { id, state: 'unknown' }
  }
  // Wayland routes every grab through the desktop portal, which RedLog cannot
  // query ahead of time.
  if (opts.platform === 'linux' && opts.env.XDG_SESSION_TYPE === 'wayland') return { id, state: 'unknown' }
  return { id, state: 'not-applicable' }
}

/** The command the connection monitor reads the socket table with — the same
 *  choice `snapshot()` in connection-monitor.ts makes. lsof on macOS is
 *  best-effort attribution there, not a requirement. */
export function socketTableCommand(platform: NodeJS.Platform): string | null {
  if (platform === 'linux') return 'ss'
  if (platform === 'darwin' || platform === 'win32') return 'netstat'
  return null
}

export function connectionTablePrerequisite(opts: {
  platform: NodeJS.Platform
  found: (cmd: string) => boolean
}): CapturePrerequisite | null {
  const cmd = socketTableCommand(opts.platform)
  if (!cmd) return null
  if (opts.found(cmd)) return { id: cmd, state: 'granted' }
  // Debian/Kali, as runtime-preflight assumes. netstat ships with macOS and
  // Windows; there is no install command to offer for it.
  return opts.platform === 'linux'
    ? { id: cmd, state: 'missing', fix: { kind: 'copy', command: 'sudo apt install iproute2' } }
    : { id: cmd, state: 'missing' }
}

export function isOpenablePrerequisiteUrl(url: unknown): url is string {
  return typeof url === 'string' && OPENABLE.has(url)
}

function readScreenAccess(): MediaAccessStatus | null {
  try { return systemPreferences.getMediaAccessStatus('screen') as MediaAccessStatus } catch { return null }
}

/** The screen-recording prerequisite on this machine, now. */
export function currentScreenRecording(): CapturePrerequisite {
  return screenRecordingPrerequisite({ platform: process.platform, env: process.env, readStatus: readScreenAccess })
}

// A PATH walk per health read is wasted work; the command does not appear
// mid-engagement often enough to need sub-minute freshness.
const COMMAND_TTL_MS = 120_000
let commandCache: { at: number; value: CapturePrerequisite | null } | null = null

function currentConnectionTable(now = Date.now()): CapturePrerequisite | null {
  if (commandCache && now - commandCache.at < COMMAND_TTL_MS) return commandCache.value
  const value = connectionTablePrerequisite({ platform: process.platform, found: (cmd) => isOnPath(cmd) })
  commandCache = { at: now, value }
  return value
}

export function installCapturePrerequisites(): void {
  configureCapturePrerequisites(() => {
    const conn = currentConnectionTable()
    return {
      screenshot: [currentScreenRecording()],
      ...(conn ? { 'connection-monitor': [conn] } : {})
    }
  })
  // app:openExternal stays http/https only. This opens one named privacy pane.
  ipcMain.handle('capture:openPrerequisiteFix', async (_e, url: unknown) => {
    if (process.platform !== 'darwin' || !isOpenablePrerequisiteUrl(url)) return { ok: false, error: 'not allowed' }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
