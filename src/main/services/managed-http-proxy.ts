import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { X509Certificate, randomBytes } from 'node:crypto'
import http from 'node:http'
import { managedProxyUrl } from '../../core/managed-proxy-url'
import { VERIFY_HOST } from '../../core/http-verify'

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

type StatusListener = (next: ManagedProxyStatus, previous: ManagedProxyStatus) => void

interface Dependencies {
  spawn: typeof nodeSpawn
  exists: typeof existsSync
  fingerprint: (caPath: string) => CaFingerprint | null
  readinessTimeoutMs: number
  probe: (url: string, token: string) => Promise<boolean>
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

const DEFAULT_DEPS: Dependencies = {
  spawn: nodeSpawn,
  exists: existsSync,
  fingerprint: readCaFingerprint,
  // First start after installing Python packages can still be importing them
  // at five seconds. Keep it starting, with a bounded opportunity to bind.
  readinessTimeoutMs: 30_000,
  probe: probeManagedProxy
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
  private generation = 0
  private listeners = new Set<StatusListener>()
  private caPath: string | null = null
  private readonly deps: Dependencies

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps }
  }

  status(): ManagedProxyStatus {
    if (!this.caPath) return { ...this.snapshot }
    const certReady = this.deps.exists(this.caPath)
    const caFingerprint = certReady ? this.deps.fingerprint(this.caPath) : null
    return {
      ...this.snapshot,
      caPath: this.caPath,
      certReady,
      ...(caFingerprint ? { caFingerprint } : {})
    }
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
  noteStartFailure(error: string): ManagedProxyStatus {
    if (this.snapshot.state === 'running' || this.snapshot.state === 'starting') return this.status()
    this.update({ state: 'failed', url: null, error })
    return this.status()
  }

  private update(next: ManagedProxyStatus): void {
    const previous = this.status()
    this.snapshot = next
    const current = this.status()
    for (const listener of this.listeners) listener(current, previous)
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
          env: { ...process.env, REDLOG_PROXY_READY_TOKEN: token }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finish({ state: /ENOENT/i.test(message) ? 'unavailable' : 'failed', url: null, error: message })
        return
      }

      this.child = child
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
      const consume = (chunk: Buffer | string): void => {
        const text = String(chunk)
        diagnostics = `${diagnostics}${text}`.slice(-4_000)
        void checkReady()
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)
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
        if (child.exitCode === null && !child.killed) {
          try { child.kill() } catch { /* already exited */ }
        }
      }, this.deps.readinessTimeoutMs)
      poll = setInterval(() => { void checkReady() }, 200)
      void checkReady()
    })
    const started = this.startPromise
    void started.then(() => { if (this.startPromise === started) this.startPromise = null })
    return started
  }

  stop(): ManagedProxyStatus {
    this.generation++
    const child = this.child
    const cancel = this.cancelStart
    this.child = null
    this.startPromise = null
    this.cancelStart = null
    this.update({ state: 'stopped', url: null })
    cancel?.()
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill() } catch { /* already exited */ }
    }
    return this.status()
  }
}

export const managedHttpProxy = new ManagedHttpProxy()
