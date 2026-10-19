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
  /** Stop a download in progress; the `download()` promise then rejects. */
  cancelDownload?(): void
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
  /** Before the restart: save what must be saved. A throw means it could not
   *  be, and the restart does not happen. */
  beforeRestart(version: string): Promise<void>
  /** Asked when `beforeRestart` threw: try the save again, or leave everything
   *  running as it is. Absent, the error is rethrown to the caller. */
  onRestartBlocked?(error: Error, version: string): Promise<'retry' | 'cancel'>
  /** Let the quit through without the quit-guard dialog: the operator has just
   *  answered a more specific one. */
  allowQuit(): void
  /** The flow moved. For whoever shows its state; it changes nothing here. */
  onState?(state: UpdateFlowState, readyVersion: string | null): void
}

export type UpdateFlowState = 'idle' | 'downloading' | 'ready' | 'installing'

const sameImpact = (a: QuitImpact | null, b: QuitImpact | null): boolean =>
  (a === null && b === null) ||
  (a !== null && b !== null &&
    a.terminals === b.terminals && a.proxyRunning === b.proxyRunning &&
    a.externalActive === b.externalActive && a.project === b.project)

export class UpdateFlow {
  private current: UpdateFlowState = 'idle'
  private ready: string | null = null
  private cancelling = false

  private get state(): UpdateFlowState { return this.current }
  private set state(next: UpdateFlowState) {
    if (next === this.current) return
    this.current = next
    this.deps.onState?.(next, this.ready)
  }

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
    this.cancelling = false
    this.state = 'downloading'
    try {
      await this.deps.port.download()
    } catch (e) {
      this.state = 'idle'
      // Cancelling is the operator's own choice, not a failure to report.
      const cancelled = this.cancelling
      this.cancelling = false
      if (!cancelled) await this.deps.onDownloadFailed(e as Error)
      return
    }
    this.cancelling = false
    this.ready = version
    this.state = 'ready'
    if ((await this.deps.announceReady(version)) === 'now') await this.install()
  }

  /** Stop the download in progress. False when there is none or the port
   *  cannot stop one, in which case it carries on. */
  cancel(): boolean {
    if (this.state !== 'downloading' || !this.deps.port.cancelDownload) return false
    this.cancelling = true
    this.deps.port.cancelDownload()
    return true
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
      for (;;) {
        try {
          await this.deps.beforeRestart(version)
          break
        } catch (e) {
          if (!this.deps.onRestartBlocked) throw e
          // Nothing was saved, so nothing may stop: cancelling leaves the
          // download ready and every source running.
          if ((await this.deps.onRestartBlocked(e as Error, version)) !== 'retry') { this.state = 'ready'; return }
        }
      }
      this.deps.allowQuit()
      this.deps.port.quitAndInstall()
    } catch (e) {
      // Nothing was restarted: the download is still ready to install.
      this.state = 'ready'
      throw e
    }
  }
}
