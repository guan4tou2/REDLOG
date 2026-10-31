import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/**
 * Local stream sources for #290: every shape of long or broken HTTP traffic
 * the capture path has to keep, served from 127.0.0.1 only.
 *
 *   /large?bytes=N              one response of N deterministic bytes
 *   /slow?chunks=N&interval=ms  a chunked text/plain trickle (not SSE)
 *   /sse?interval=ms&count=N&pad=B&dropAfter=K
 *                               text/event-stream; count 0 runs until closed;
 *                               dropAfter destroys the socket after K events
 *   /disconnect                 announces more bytes than it sends, then dies
 *   ws  /ws?push=ms&size=B&dropAfter=K
 *                               echoes every message with its type; pushes a
 *                               binary frame of B bytes every `push` ms
 *
 * Every event and frame carries its own sequence number, so a reader can say
 * which ones were saved without trusting any count the app reports.
 */
export interface StreamSources {
  port: number
  url: (path: string) => string
  close: () => Promise<void>
}

export function body(bytes: number): Buffer {
  const out = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff
  return out
}

/** One SSE event. The payload mixes UTF-8 and padding so that a byte-exact
 * comparison catches re-encoding as well as loss. */
export function sseEvent(seq: number, pad: number): string {
  return `id: ${seq}\ndata: {"seq":${seq},"t":${Date.now()},"text":"中文 ${seq}","pad":"${'x'.repeat(pad)}"}\n\n`
}

/** First 8 bytes of every pushed binary frame: the sequence number, then a
 * fixed tag, so a frame is identifiable from its bytes alone. */
export function binaryFrame(seq: number, size: number): Buffer {
  const out = body(Math.max(size, 8))
  out.writeUInt32BE(seq, 0)
  out.writeUInt32BE(0x52454447, 4) // "REDG"
  return out
}

export async function startStreamSources(): Promise<StreamSources> {
  const { WebSocketServer } = await import('ws')
  const sockets = new Set<Socket>()
  const timers = new Set<NodeJS.Timeout>()
  const every = (ms: number, fn: () => void): NodeJS.Timeout => { const t = setInterval(fn, ms); timers.add(t); return t }
  const stop = (t: NodeJS.Timeout): void => { clearInterval(t); timers.delete(t) }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const n = (key: string, fallback: number): number => Number(url.searchParams.get(key) ?? fallback)
    if (url.pathname === '/large') {
      const data = body(n('bytes', 1 << 20))
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length })
      res.end(data)
    } else if (url.pathname === '/slow') {
      const total = n('chunks', 10)
      let sent = 0
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      const t = every(n('interval', 1000), () => {
        sent++
        res.write(`slow ${sent} 中文\n`)
        if (sent >= total) { stop(t); res.end() }
      })
      res.on('close', () => stop(t))
    } else if (url.pathname === '/sse') {
      const count = n('count', 0)
      const pad = n('pad', 64)
      const dropAfter = n('dropAfter', 0)
      let seq = 0
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const t = every(n('interval', 1000), () => {
        seq++
        res.write(sseEvent(seq, pad))
        if (dropAfter && seq >= dropAfter) { stop(t); res.destroy() }
        else if (count && seq >= count) { stop(t); res.end() }
      })
      res.on('close', () => stop(t))
    } else if (url.pathname === '/disconnect') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 4096 })
      res.write(body(1024))
      setTimeout(() => res.destroy(), 200)
    } else {
      res.writeHead(404); res.end()
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname !== '/ws') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => {
      const size = Number(url.searchParams.get('size') ?? 1024)
      const dropAfter = Number(url.searchParams.get('dropAfter') ?? 0)
      let seq = 0
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }))
      const push = Number(url.searchParams.get('push') ?? 0)
      if (push > 0) {
        const t = every(push, () => {
          seq++
          ws.send(binaryFrame(seq, size), { binary: true })
          if (dropAfter && seq >= dropAfter) { stop(t); ws.terminate() }
        })
        ws.on('close', () => stop(t))
      }
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    url: path => `http://127.0.0.1:${port}${path}`,
    close: async () => {
      for (const t of timers) clearInterval(t)
      for (const ws of wss.clients) ws.terminate()
      for (const s of sockets) s.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

/** What a client actually received through the proxy, independent of what
 * RedLog says it saved. */
export interface Received { bytes: number; sha256: () => string; text: () => string; ended: boolean; error?: string }

export function proxiedGet(proxy: URL, target: string): { received: Received; abort: () => void } {
  const parts: Buffer[] = []
  const received: Received = {
    bytes: 0, ended: false,
    sha256: () => createHash('sha256').update(Buffer.concat(parts)).digest('hex'),
    text: () => Buffer.concat(parts).toString('utf8')
  }
  const req = request({ host: proxy.hostname, port: proxy.port, path: target, headers: { host: new URL(target).host } }, res => {
    res.on('data', (data: Buffer) => { parts.push(data); received.bytes += data.length })
    res.on('end', () => { received.ended = true })
    res.on('error', e => { received.error = e.message })
  })
  req.on('error', e => { received.error = e.message })
  req.end()
  return { received, abort: () => req.destroy() }
}

/** A WebSocket through the proxy's CONNECT tunnel, as a browser would open
 * one through an explicit HTTP proxy. */
export async function proxiedWebSocket(proxy: URL, target: string): Promise<import('ws').WebSocket> {
  const { WebSocket } = await import('ws')
  const host = new URL(target).host
  const tunnel = await new Promise<Socket>((resolve, reject) => {
    const connect = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: host })
    connect.on('connect', (_res, socket) => resolve(socket)); connect.on('error', reject); connect.end()
  })
  const ws = new WebSocket(target.replace(/^http/, 'ws'), { createConnection: () => tunnel })
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return ws
}

/** Resident memory of a process and all its descendants, in bytes. mitmdump
 * installed as a tool shim is a launcher whose child does the work, so the
 * process alone would measure the wrong thing. */
export function treeRss(pid: number): number {
  const rows: Array<[number, number, number]> = []
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) { const [p, pp, ws] = line.trim().split(/\s+/).map(Number); if (p) rows.push([p, pp, ws]) }
  } else {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    for (const line of out.split('\n')) { const [p, pp, kb] = line.trim().split(/\s+/).map(Number); if (p) rows.push([p, pp, kb * 1024]) }
  }
  const tree = new Set([pid])
  for (let grew = true; grew;) {
    grew = false
    for (const [p, pp] of rows) if (tree.has(pp) && !tree.has(p)) { tree.add(p); grew = true }
  }
  return rows.filter(([p]) => tree.has(p)).reduce((sum, [, , rss]) => sum + rss, 0)
}

/** Kill a process tree the way a crash or Task Manager would: no signal the
 * process can catch, so no shutdown hook runs. */
export function hardKill(pid: number): void {
  if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  else process.kill(pid, 'SIGKILL')
}
