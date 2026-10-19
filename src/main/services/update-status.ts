// What the About page may say about updating, held in the main process because
// that is where the check, the download and the restart actually happen
// (Spec 061 FR-001, FR-002). Pure of Electron: the updater feeds it and the
// window only reads it.

export type UpdateStage =
  | 'idle'          // nothing in flight; `result` says how the last check went
  | 'checking'
  | 'available'     // a newer version exists and has not been fetched
  | 'downloading'
  | 'ready'         // downloaded; nothing restarts until the operator says so
  | 'installing'
  | 'failed'        // the check or the download did not complete
  | 'unavailable'   // this build cannot be updated from here (air-gap, no installer)

/** How the last finished check ended. Kept apart so "up to date" is never what
 *  a failed or inapplicable check is shown as. */
export type UpdateResult = 'upToDate' | 'failed' | 'airgap' | 'noInstaller'

export interface UpdateStatus {
  stage: UpdateStage
  /** `in-app`: downloaded and installed by RedLog. `download-page`: the
   *  operator fetches the installer and replaces the app. */
  method: 'in-app' | 'download-page'
  packaged: boolean
  currentVersion: string
  targetVersion: string | null
  /** 0–100 while downloading; null otherwise or when unknown. */
  progress: number | null
  result: UpdateResult | null
  checkedAt: number | null
  /** Where the installer can be fetched by hand. */
  releaseUrl: string
  /** Whether RedLog looks by itself at launch. Air-gap overrides it. */
  autoCheck: boolean
  /** The operator was sent to the download page for `targetVersion` and the
   *  running version is still older: not finished, and only a newer running
   *  version ends it (never the page having been opened). */
  unfinished: boolean
}

export class UpdateStatusStore {
  private status: UpdateStatus
  private listeners = new Set<(status: UpdateStatus) => void>()

  constructor(initial: Pick<UpdateStatus, 'method' | 'packaged' | 'currentVersion' | 'releaseUrl' | 'autoCheck'>) {
    this.status = { stage: 'idle', targetVersion: null, progress: null, result: null, checkedAt: null, unfinished: false, ...initial }
  }

  get(): UpdateStatus { return { ...this.status } }

  patch(change: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...change }
    const snapshot = this.get()
    for (const listener of this.listeners) listener(snapshot)
  }

  onChange(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** Whether a release carries an installer this machine could use. A release
 *  that is only source, or only another platform's files, is not an update the
 *  operator can take from here. Names follow electron-builder's output:
 *  `RedLog-x-arm64.dmg`, `RedLog.Setup.x.exe`, `redlog_x_amd64.deb`. */
export function hasInstallerFor(assetNames: string[], platform: string, arch: string): boolean {
  const names = assetNames.map((n) => n.toLowerCase())
  if (platform === 'darwin') {
    const armBuild = (n: string): boolean => n.includes('arm64')
    return names.some((n) => n.endsWith('.dmg') && (arch === 'arm64' ? armBuild(n) : !armBuild(n)))
  }
  if (platform === 'win32') return names.some((n) => n.endsWith('.exe') && !n.endsWith('.blockmap'))
  if (platform === 'linux') return names.some((n) => n.endsWith('.deb') || n.endsWith('.appimage'))
  return false
}
