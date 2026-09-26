import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { managedProxyUrl } from '../../core/managed-proxy-url'

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
}

const READY_PATTERN = /proxy server listening|listening at/i
const DEFAULT_DEPS: Dependencies = {
  spawn: nodeSpawn,
  exists: existsSync,
  fingerprint: readCaFingerprint,
  readinessTimeoutMs: 5_000
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
    this.startPromise = new Promise((resolve) => {
      let settled = false
      let diagnostics = ''
      let timer: ReturnType<typeof setTimeout> | null = null

      const finish = (next: ManagedProxyStatus): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (generation !== this.generation) {
          resolve(this.status())
          return
        }
        this.update(next)
        this.startPromise = null
        resolve(this.status())
      }

      let child: ChildProcess
      try {
        child = this.deps.spawn('mitmdump', buildManagedProxyArgs(input.addonPath, input.port, listenHost), {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finish({ state: /ENOENT/i.test(message) ? 'unavailable' : 'failed', url: null, error: message })
        return
      }

      this.child = child
      const consume = (chunk: Buffer | string): void => {
        const text = String(chunk)
        diagnostics = `${diagnostics}${text}`.slice(-4_000)
        if (READY_PATTERN.test(text)) {
          finish({ state: 'running', url, pid: child.pid })
        }
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)
      child.once('error', (error: NodeJS.ErrnoException) => {
        this.child = null
        finish({
          state: error.code === 'ENOENT' ? 'unavailable' : 'failed',
          url: null,
          error: error.code === 'ENOENT' ? 'mitmdump is not installed or not on PATH' : error.message
        })
      })
      child.once('exit', (code, signal) => {
        this.child = null
        const reason = diagnostics.trim() || `mitmdump exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
        if (!settled) finish({ state: 'failed', url: null, error: reason })
        else if (this.snapshot.state === 'running') {
          this.update({ state: 'failed', url: null, error: reason })
        }
      })
      timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          finish({ state: 'running', url, pid: child.pid })
        } else {
          finish({ state: 'failed', url: null, error: diagnostics.trim() || 'mitmdump did not become ready' })
        }
      }, this.deps.readinessTimeoutMs)
    })
    return this.startPromise
  }

  stop(): ManagedProxyStatus {
    this.generation++
    const child = this.child
    this.child = null
    this.startPromise = null
    this.update({ state: 'stopped', url: null })
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill() } catch { /* already exited */ }
    }
    return this.status()
  }
}

export const managedHttpProxy = new ManagedHttpProxy()
