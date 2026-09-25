import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Who is already on the capture port, in words the operator can act on.
//
// mitmdump's own answer is a multi-line startup dump ending in a localised
// winsock error and a suggestion to pass `--mode regular@8082` — a mitmproxy
// flag, not a RedLog setting. So the operator learned neither what had taken
// the port nor that the port is theirs to change. The likeliest holder is
// Burp Suite, which listens on 8080 by default; that was RedLog's default
// too, so the first click of "Start HTTP capture" failed on most machines
// this product is installed on.

export interface PortProbe {
  /** Can we bind host:port right now? */
  free: (host: string, port: number) => Promise<boolean>
  /** Best-effort name of the process holding it, or null. */
  holder: (port: number) => Promise<string | null>
}

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    try { server.listen(port, host) } catch { resolve(false) }
  })
}

/** Best effort and never fatal: if we cannot name the holder we still say the
 *  port is taken, which is the part that matters. */
async function findHolder(port: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], { timeout: 4_000, windowsHide: true })
      const line = stdout.split(/\r?\n/).find((l) => /LISTENING/i.test(l) && new RegExp(`:${port}\\s`).test(l))
      const pid = line?.trim().split(/\s+/).pop()
      if (!pid || !/^\d+$/.test(pid)) return null
      const { stdout: tasks } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { timeout: 4_000, windowsHide: true })
      const name = tasks.split('","')[0]?.replace(/^"/, '').trim()
      return name && name !== 'INFO:' ? `${name} (PID ${pid})` : `PID ${pid}`
    }
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fcp'], { timeout: 4_000 })
    const pid = /^p(\d+)/m.exec(stdout)?.[1]
    const name = /^c(.+)$/m.exec(stdout)?.[1]
    if (!pid) return null
    return name ? `${name} (PID ${pid})` : `PID ${pid}`
  } catch {
    return null
  }
}

export const DEFAULT_PORT_PROBE: PortProbe = { free: canBind, holder: findHolder }

/**
 * A ready-to-show reason the capture proxy cannot start here, or null when the
 * endpoint is free.
 */
export async function whoHoldsPort(
  endpoint: { host: string; port: number },
  probe: PortProbe = DEFAULT_PORT_PROBE
): Promise<string | null> {
  if (await probe.free(endpoint.host, endpoint.port)) return null
  const holder = await probe.holder(endpoint.port)
  const who = holder ? ` by ${holder}` : ''
  return `${endpoint.host}:${endpoint.port} is already in use${who}. ` +
    'Change the HTTP capture port in Settings → Browser, or stop what is using it.'
}
