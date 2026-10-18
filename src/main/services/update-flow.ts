import type { QuitImpact } from '../quit-guard'

// Download and restart are two separate decisions (Spec 061 FR-004, FR-005).
//
// The first click agrees to fetch a file. It does not agree to end every
// built-in terminal and the managed proxy at some later moment, so a finished
// download only says "ready". Restarting is its own action, and it asks about
// what is live AT THAT MOMENT: the list is computed when the question is asked
// and again when it is answered, because a terminal opened while the dialog was
// up is something the operator has not agreed to lose.
//
// Pure of Electron on purpose: the dialogs, the updater and the quit are
// handed in, so the sequence can be tested without a window.

export interface UpdatePort {
  download(): Promise<void>
  quitAndInstall(): void
}

export interface UpdateFlowDeps {
  port: UpdatePort
  /** Agree to fetch the file. */
  askDownload(version: string): Promise<boolean>
  /** The download finished. A closable notice; resolves 'now' only if the
   *  operator chose to install. Closing it, or Escape, is 'later'. */
  announceReady(version: string): Promise<'now' | 'later'>
  /** What a restart would end right now; null when nothing live. */
  impact(): QuitImpact | null
  /** Shown only when something is live. Resolves true only on an explicit yes;
   *  the default and Escape are no. */
  confirmRestart(impact: QuitImpact, version: string): Promise<boolean>
  onDownloadFailed(error: Error): Promise<void>
  /** Before the restart. A failure here is the caller's to surface. */
  beforeRestart(version: string): Promise<void>
  /** Let the quit through without the quit-guard dialog: the operator has just
   *  answered a more specific one. */
  allowQuit(): void
}

export type UpdateFlowState = 'idle' | 'downloading' | 'ready' | 'installing'

const sameImpact = (a: QuitImpact | null, b: QuitImpact | null): boolean =>
  (a === null && b === null) ||
  (a !== null && b !== null &&
    a.terminals === b.terminals && a.proxyRunning === b.proxyRunning &&
    a.externalActive === b.externalActive && a.project === b.project)

export class UpdateFlow {
  private state: UpdateFlowState = 'idle'
  private ready: string | null = null

  constructor(private readonly deps: UpdateFlowDeps) {}

  status(): { state: UpdateFlowState; readyVersion: string | null } {
    return { state: this.state, readyVersion: this.ready }
  }

  /** An update is available: ask, download, say "ready". Never restarts unless
   *  the operator chooses to, and never twice at once. */
  async offer(version: string): Promise<void> {
    if (this.state === 'downloading' || this.state === 'installing') return
    if (this.state === 'ready' && this.ready) return this.install()

    if (!(await this.deps.askDownload(version))) return
    // A second click while the dialog was up must not start a second download.
    if (this.state !== 'idle') return
    this.state = 'downloading'
    try {
      await this.deps.port.download()
    } catch (e) {
      this.state = 'idle'
      await this.deps.onDownloadFailed(e as Error)
      return
    }
    this.state = 'ready'
    this.ready = version
    if ((await this.deps.announceReady(version)) === 'now') await this.install()
  }

  /** Restart into the downloaded version, once the operator has seen what that
   *  ends. Returns without restarting if they decline or nothing is ready. */
  async install(): Promise<void> {
    if (this.state !== 'ready' || !this.ready) return
    const version = this.ready
    this.state = 'installing'
    try {
      // Ask until the answer was given about what is true now.
      for (;;) {
        const asked = this.deps.impact()
        if (asked === null) break
        if (!(await this.deps.confirmRestart(asked, version))) { this.state = 'ready'; return }
        if (sameImpact(asked, this.deps.impact())) break
      }
      await this.deps.beforeRestart(version)
      this.deps.allowQuit()
      this.deps.port.quitAndInstall()
    } catch (e) {
      // Nothing was restarted: the download is still ready to install.
      this.state = 'ready'
      throw e
    }
  }
}
