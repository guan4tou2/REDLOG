import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { X509Certificate, createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import { managedProxyUrl } from '../../core/managed-proxy-url'
import { VERIFY_HOST, isVerifyNonce, type HttpVerifyReport } from '../../core/http-verify'
import { parseUnsavedGapLine, type UnsavedGap } from '../../core/unsaved-gap'

export type ManagedProxyState = 'stopped' | 'starting' | 'running' | 'unavailable' | 'failed'

export interface ManagedProxyStatus {
  state: ManagedProxyState
  url: string | null
  pid?: number
  error?: string
  caPath?: string
  /** The CA file exists. It says nothing about who trusts it. */
  certReady?: boolean
  /** The CA's own fingerprints, so trust can be removed by identity rather
   *  than by the name "mitmproxy", which other tools' CAs share (#220). */
  caFingerprint?: CaFingerprint
  verificationEvidence?: import('../../core/http-verification-evidence').HttpVerificationEvidence | null
  verificationState?: import('../../core/http-verification-evidence').HttpVerificationState
  sourceInstance?: string
  httpsVerification?: HttpVerifyReport
  /** Events the addon could not record even as a capture gap (#460, #507),
   *  whatever the gap's reason but another project's. Present only when there
   *  are some. */
  unsavedGapEvents?: number
}

export interface CaFingerprint {
  /** uppercase hex, no separators — what certutil and `security -Z` take */
  sha1: string
  sha256: string
}

/** Fingerprints of the first certificate in a PEM file, or null. */
export function readCaFingerprint(caPath: string): CaFingerprint | null {
  try {
    const cert = new X509Certificate(readFileSync(caPath))
    const hex = (v: string): string => v.replace(/:/g, '').toUpperCase()
    return { sha1: hex(cert.fingerprint), sha256: hex(cert.fingerprint256) }
  } catch {
    return null
  }
}

/** The CA's public-key pin in the form Chrome's
 *  --ignore-certificate-errors-spki-list takes: base64 SHA-256 of the DER
 *  SubjectPublicKeyInfo. Null when the file is missing or not a certificate. */
export function readCaSpki(caPath: string): string | null {
  try {
    const spki = new X509Certificate(readFileSync(caPath)).publicKey.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(spki).digest('base64')
  } catch {
    return null
  }
}

type StatusListener = (next: ManagedProxyStatus, previous: ManagedProxyStatus) => void

interface Dependencies {
  spawn: typeof nodeSpawn
  exists: typeof existsSync
  fingerprint: (caPath: string) => CaFingerprint | null
  readinessTimeoutMs: number
  probe: (url: string, token: string) => Promise<boolean>
  requestStop: (url: string, token: string) => Promise<number | null>
  /** How long a graceful stop waits for the child to leave before killing it. */
  stopGraceMs: number
}

/** The token is delivered to the owned addon through its environment, never
 * in the request. A listening foreign proxy cannot pass by reflecting input. */
export function probeManagedProxy(url: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(new URL(url), {
      method: 'GET', path: `http://${VERIFY_HOST}/__redlog_ready`,
      headers: { host: VERIFY_HOST }, agent: false
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length > token.length) { resolve(false); req.destroy() }
      })
      res.on('end', () => resolve(res.statusCode === 200 && body === token))
      res.on('error', () => resolve(false))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(500, () => { resolve(false); req.destroy() })
    req.end()
  })
}

/** Ask the owned addon to record what it still holds and shut down (#291).
 *  The status code it answered with, or null when there was no answer. */
export function requestManagedProxyStop(url: string, token: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request(new URL(url), {
      method: 'POST', path: `http://${VERIFY_HOST}/__redlog_stop`,
      headers: { host: VERIFY_HOST, 'x-redlog-control': token, 'content-length': '0' }, agent: false
    }, (res) => {
      res.resume()
      resolve(res.statusCode ?? null)
    })
    req.on('error', () => resolve(null))
    req.setTimeout(1_000, () => { resolve(null); req.destroy() })
    req.end()
  })
}

const DEFAULT_DEPS: Dependencies = {
  spawn: nodeSpawn,
  exists: existsSync,
  fingerprint: readCaFingerprint,
  // First start after installing Python packages can still be importing them
  // at five seconds. Keep it starting, with a bounded opportunity to bind.
  readinessTimeoutMs: 30_000,
  probe: probeManagedProxy,
  requestStop: requestManagedProxyStop,
  // The addon waits up to two seconds for sends already under way. Inside the
  // five seconds a following start waits on `released()`.
  stopGraceMs: 3_500
}

export function buildManagedProxyArgs(addonPath: string, port: number, listenHost = '127.0.0.1'): string[] {
  return [
    '--listen-host', listenHost,
    '--listen-port', String(port),
    '--set', 'block_global=false',
    '-s', addonPath
  ]
}

export class ManagedHttpProxy {
  private child: ChildProcess | null = null
  private snapshot: ManagedProxyStatus = { state: 'stopped', url: null }
  private startPromise: Promise<ManagedProxyStatus> | null = null
  private cancelStart: (() => void) | null = null
  private sourceInstance: string | undefined
  private generation = 0
  private listeners = new Set<StatusListener>()
  private gapListeners = new Set<(gap: UnsavedGap) => void>()
  private proof: { report: HttpVerifyReport; ca: string } | null = null
  private startedAt = 0
  private caPath: string | null = null
  // Kept across restarts: a restart does not bring those events back.
  private unsavedGapEvents = 0
  // The child last told to stop, until it has exited. A kill is a request:
  // mitmdump takes a few hundred milliseconds to let go of its port, and a
  // start inside that window found the port held — by the process it had just
  // replaced. A project switch is exactly that: close stops A's proxy, open
  // auto-starts B's, and B reported the port in use.
  private exiting: Promise<void> | null = null
  // How to ask the running child to stop itself. Its own secret, not the
  // readiness token: the addon hands that one to anyone who asks for it.
  private control: { child: ChildProcess; url: string; token: string } | null = null
  // A child asked to stop that has not exited yet. Quitting inside its grace
  // must still kill it: the timer that would have done so dies with the app.
  private leaving: ChildProcess | null = null
  private readonly deps: Dependencies

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps }
  }

  status(): ManagedProxyStatus {
    const unsaved = this.unsavedGapEvents > 0 ? { unsavedGapEvents: this.unsavedGapEvents } : {}
    if (!this.caPath) return { ...this.snapshot, sourceInstance: this.sourceInstance, ...unsaved }
    const certReady = this.deps.exists(this.caPath)
    const caFingerprint = certReady ? this.deps.fingerprint(this.caPath) : null
    if (this.proof && this.proof.ca !== caFingerprint?.sha256) this.proof = null
    return {
      ...this.snapshot,
      sourceInstance: this.sourceInstance,
      ...unsaved,
      ...(this.snapshot.state === 'running' && this.proof ? { httpsVerification: this.proof.report } : {}),
      caPath: this.caPath,
      certReady,
      ...(caFingerprint ? { caFingerprint } : {})
    }
  }

  /** A nonce check is proof for this process and CA, never a claim about all clients. */
  noteVerification(report: HttpVerifyReport): void {
    const current = this.status()
    if (current.state !== 'running' || report.scheme !== 'https' || report.rejected
      || !isVerifyNonce(report.nonce) || report.receivedAt < this.startedAt || !current.caFingerprint) return
    this.proof = { report: { ...report }, ca: current.caFingerprint.sha256 }
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * An attempt to start failed before `start()` was ever reached.
   *
   * The caller does its own preflight — the addon has to exist, a project has
   * to be open, the port has to be free — and each of those returned a failed
   * status object that nothing recorded. `status()` reports this snapshot, so
   * every surface reading it saw `stopped`: not "tried and could not", but
   * "nothing has been tried". Those are different facts and the operator acts
   * on them differently, which is the whole of §VI.
   *
   * It became reachable without anyone pressing a button when capture started
   * taking itself up at project open — so a port already in use now means an
   * engagement that quietly records no HTTP while the strip says stopped.
   *
   * A running proxy is never overwritten: a preflight that fails while the
   * thing is up is the preflight being wrong, not the proxy stopping.
   */
  /**
   * Resolves once the child the last stop signalled has exited, or after
   * `timeoutMs`. A start's port preflight waits on this, so the port it probes
   * is not still held by our own outgoing process. Past the timeout the
   * preflight runs anyway and reports whoever holds the port.
   */
  async released(timeoutMs = 5_000): Promise<void> {
    const exiting = this.exiting
    if (!exiting) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([exiting, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
    clearTimeout(timer)
  }

  /**
   * With `control`, the addon is asked to stop itself first (#291). On Windows
   * `kill()` is TerminateProcess: mitmdump's shutdown hook never runs, and the
   * events its send queue held were lost with nothing to say so. Asked, it
   * records them and exits. A refusal — an addon without the stop path — is
   * killed at once; no answer, or no exit within the grace, is killed then.
   */
  private terminate(child: ChildProcess, control?: { url: string; token: string }): void {
    if (child.exitCode !== null || child.killed) return
    // Listen before signalling: an exit can be delivered synchronously.
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    this.exiting = exited
    void exited.then(() => { if (this.exiting === exited) this.exiting = null })
    const kill = (signal?: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.killed) return
      try { child.kill(signal) } catch { /* already exited */ }
    }
    if (!control) { kill(); return }
    this.leaving = child
    // Past the grace, SIGKILL: on POSIX a SIGTERM asks for the shutdown this
    // child is already in, and one that hangs would hold the port past the
    // five seconds a following start waits. Its marker covers what it held.
    const fallback = setTimeout(() => kill('SIGKILL'), this.deps.stopGraceMs)
    void exited.then(() => {
      clearTimeout(fallback)
      if (this.leaving === child) this.leaving = null
    })
    void this.deps.requestStop(control.url, control.token).then((status) => {
      if (status !== null && status !== 202) { clearTimeout(fallback); kill() }
    })
  }

  noteStartFailure(error: string): ManagedProxyStatus {
    if (this.snapshot.state === 'running' || this.snapshot.state === 'starting') return this.status()
    this.update({ state: 'failed', url: null, error })
    return this.status()
  }

  private update(next: ManagedProxyStatus): void {
    const previous = this.status()
    if (next.state !== 'running') this.proof = null
    if (next.state === 'starting') { this.startedAt = Date.now(); this.sourceInstance = randomBytes(16).toString('hex') }
    this.snapshot = next
    const current = this.status()
    for (const listener of this.listeners) listener(current, previous)
  }

  private noteUnsavedGap(gap: UnsavedGap): void {
    // Another project's gap is not the open project's loss: it is told to
    // onUnsavedGap, with its owner, and left out of this count.
    if (gap.reason !== 'project-switched') {
      const previous = this.status()
      this.unsavedGapEvents += gap.units
      const current = this.status()
      for (const listener of this.listeners) listener(current, previous)
    }
    for (const listener of this.gapListeners) listener(gap)
  }

  /** Called for each gap the addon says it could not save, with the window and
   *  the project it reports. */
  onUnsavedGap(listener: (gap: UnsavedGap) => void): () => void {
    this.gapListeners.add(listener)
    return () => this.gapListeners.delete(listener)
  }

  /** Splits a stream into lines, carrying a partial one into the next chunk. */
  private gapLineReader(nonce: string): (text: string) => void {
    let pending = ''
    return (text) => {
      const lines = `${pending}${text}`.split(/\r?\n/)
      pending = (lines.pop() ?? '').slice(-1_000)
      for (const line of lines) {
        const gap = parseUnsavedGapLine(line, nonce)
        if (gap) this.noteUnsavedGap(gap)
      }
    }
  }

  start(input: { addonPath: string; port: number; listenHost?: string; caPath?: string }): Promise<ManagedProxyStatus> {
    if (this.snapshot.state === 'running') return Promise.resolve(this.status())
    if (this.startPromise) return this.startPromise

    const listenHost = input.listenHost ?? '127.0.0.1'
    const url = managedProxyUrl({ host: listenHost, port: input.port })
    this.caPath = input.caPath ?? null
    if (!this.deps.exists(input.addonPath)) {
      this.update({ state: 'failed', url: null, error: `mitmproxy addon not found: ${input.addonPath}` })
      return Promise.resolve(this.status())
    }

    this.update({ state: 'starting', url })
    const generation = ++this.generation
    const token = randomBytes(32).toString('hex')
    const controlToken = randomBytes(32).toString('hex')
    // Proves a gap line is the addon's: see core/unsaved-gap.ts.
    const gapNonce = randomBytes(32).toString('hex')
    this.startPromise = new Promise((resolve) => {
      let settled = false
      let diagnostics = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      let poll: ReturnType<typeof setInterval> | null = null

      const finish = (next: ManagedProxyStatus): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (poll) clearInterval(poll)
        if (generation !== this.generation) {
          resolve(this.status())
          return
        }
        this.update(next)
        this.startPromise = null
        this.cancelStart = null
        resolve(this.status())
      }
      this.cancelStart = () => finish(this.status())

      let child: ChildProcess
      try {
        child = this.deps.spawn('mitmdump', buildManagedProxyArgs(input.addonPath, input.port, listenHost), {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, REDLOG_PROXY_READY_TOKEN: token, REDLOG_PROXY_CONTROL_TOKEN: controlToken, REDLOG_PROXY_GAP_NONCE: gapNonce }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finish({ state: /ENOENT/i.test(message) ? 'unavailable' : 'failed', url: null, error: message })
        return
      }

      this.child = child
      this.control = { child, url, token: controlToken }
      let probing = false
      const checkReady = async (): Promise<void> => {
        if (settled || probing || generation !== this.generation || child.exitCode !== null || child.killed) return
        probing = true
        const ready = await this.deps.probe(url, token).catch(() => false)
        probing = false
        if (ready && !settled && generation === this.generation && this.child === child && child.exitCode === null && !child.killed) {
          finish({ state: 'running', url, pid: child.pid })
        }
      }
      const consume = (readGapLines: (text: string) => void) => (chunk: Buffer | string): void => {
        const text = String(chunk)
        // The nonce is only for the line reader: this text can reach the status error.
        diagnostics = `${diagnostics}${text}`.split(gapNonce).join('[nonce]').slice(-4_000)
        readGapLines(text)
        void checkReady()
      }
      child.stdout?.on('data', consume(this.gapLineReader(gapNonce)))
      child.stderr?.on('data', consume(this.gapLineReader(gapNonce)))
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (this.child === child) this.child = null
        finish({
          state: error.code === 'ENOENT' ? 'unavailable' : 'failed',
          url: null,
          error: error.code === 'ENOENT' ? 'mitmdump is not installed or not on PATH' : error.message
        })
      })
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null
        // Only the generation that owns this child may speak for the status.
        // A restart is a stop and a start: the new child can be up and
        // `running` before the old one's `exit` is delivered, and without
        // this guard that late event rewrote the new proxy's status to
        // `failed` — carrying the OLD process's output as the reason, which
        // for a proxy that had come up cleanly was its own readiness line.
        // A capture that was working, reported as broken, with a stale
        // explanation that read as if it had never started.
        if (generation !== this.generation) return
        const reason = diagnostics.trim() || `mitmdump exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
        if (!settled) finish({ state: 'failed', url: null, error: reason })
        else if (this.snapshot.state === 'running') {
          this.update({ state: 'failed', url: null, error: reason })
        }
      })
      timer = setTimeout(() => {
        finish({ state: 'failed', url: null, error: `mitmdump did not confirm owned readiness within ${this.deps.readinessTimeoutMs / 1000}s${diagnostics.trim() ? `: ${diagnostics.trim()}` : ''}` })
        if (this.child === child) this.child = null
        this.terminate(child)
      }, this.deps.readinessTimeoutMs)
      poll = setInterval(() => { void checkReady() }, 200)
      void checkReady()
    })
    const started = this.startPromise
    void started.then(() => { if (this.startPromise === started) this.startPromise = null })
    return started
  }

  /** `graceful` asks a running child to record what it holds before it goes.
   *  Quitting does not: the app may be gone before the answer, and a child left
   *  running holds the port. What a kill loses, its in-flight marker bounds. */
  stop(options: { graceful?: boolean } = {}): ManagedProxyStatus {
    this.generation++
    const child = this.child
    const cancel = this.cancelStart
    const control = options.graceful && this.snapshot.state === 'running' && this.control?.child === child
      ? this.control : null
    this.child = null
    this.control = null
    this.startPromise = null
    this.cancelStart = null
    this.update({ state: 'stopped', url: null })
    cancel?.()
    const leaving = this.leaving
    if (!options.graceful && leaving && leaving.exitCode === null && !leaving.killed) {
      this.leaving = null
      try { leaving.kill('SIGKILL') } catch { /* already exited */ }
    }
    if (child) this.terminate(child, control ?? undefined)
    return this.status()
  }
}

export const managedHttpProxy = new ManagedHttpProxy()
