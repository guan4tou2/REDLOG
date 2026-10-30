import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

// Mirror the real API: /api/health is public, event delivery is authenticated.
async function startCollector(token: string) {
  const events: Array<{ data: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    if (req.url === '/api/health') { res.writeHead(200).end('{"ok":true}'); return }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
    if (req.url === '/api/whoami') { res.writeHead(200).end('{}'); return }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { events.push(JSON.parse(body)); res.writeHead(201).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { port, events, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

const temporary: string[] = []
afterEach(() => { for (const p of temporary.splice(0)) fs.rmSync(p, { recursive: true, force: true }) })
const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
const suite = process.platform === 'win32' ? describe.skip : describe

suite('WSL shell directory selection', () => {
  for (const entry of ['common', 'sender'] as const) {
    // 'stale-token' is #326: with mirrored networking the native port answers,
    // because it is the Windows app, but it no longer accepts this token.
    // 'no-windows-path' is appendWindowsPath=false: cmd.exe is not on PATH and
    // only wslpath can say where it is.
    for (const variant of ['down', 'live', 'stale-token', 'no-windows-path'] as const) {
      const title = {
        down: 'does not let a stale native directory shadow the Windows app',
        live: 'keeps a live native app',
        'stale-token': 'does not adopt a live port that refuses the native token',
        'no-windows-path': 'finds cmd.exe when the Windows PATH is not appended'
      }[variant]
      it(`${entry}: ${title}`, async () => {
        const native = await startCollector(variant === 'stale-token' ? 'rotated-token' : 'native-token')
        const windows = await startCollector('windows-token')
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-wsl-directory-'))
        temporary.push(root)
        const home = path.join(root, 'native-home'), winHome = path.join(root, 'windows-home'), bin = path.join(root, 'bin')
        const system32 = variant === 'no-windows-path' ? path.join(root, 'System32') : bin
        fs.mkdirSync(bin); fs.mkdirSync(system32, { recursive: true })
        for (const [dir, token, port] of [[home, 'native-token', variant === 'down' || variant === 'no-windows-path' ? 1 : native.port], [winHome, 'windows-token', windows.port]] as const) {
          fs.mkdirSync(path.join(dir, '.redlog'), { recursive: true })
          fs.writeFileSync(path.join(dir, '.redlog', 'api-token'), token)
          fs.writeFileSync(path.join(dir, '.redlog', 'api-port'), String(port))
        }
        fs.writeFileSync(path.join(system32, 'cmd.exe'), `#!/bin/sh\nprintf '%s\\n' ${quote(winHome)}\n`, { mode: 0o755 })
        fs.writeFileSync(path.join(bin, 'wslpath'), `#!/bin/sh\nif [ "$1" = -u ]; then printf '%s\\n' ${quote(path.join(system32, 'cmd.exe'))}; else printf '%s\\n' "$1"; fi\n`, { mode: 0o755 })
        // A real WSL PATH may carry /mnt/c/Windows; this variant must not.
        const basePath = variant === 'no-windows-path' ? '/usr/local/bin:/usr/bin:/bin' : process.env.PATH
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${basePath}`, WSL_DISTRO_NAME: 'test-kali', REDLOG_SHELL: 'bash' }
        delete env._REDLOG_DIR; delete env._REDLOG_HOST; delete env.REDLOG_EXTERNAL_SESSION
        const common = path.resolve('hooks/shell-common.sh'), sender = path.resolve('hooks/redlog-send.sh')
        const script = entry === 'common'
          ? `source ${quote(common)}; _redlog_send_event command_start wsl-directory-probe`
          : `source ${quote(sender)} wsl-directory-probe command_start; wait`
        try {
          let output = ''; const result = await new Promise<number | null>((resolve, reject) => {
            const child = spawn('bash', ['--norc', '-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
            child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { output += d });
            const timer = setTimeout(() => { child.kill(); reject(new Error('directory probe exceeded 10s')) }, 10_000)
            child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve(code) })
          })
          expect(result).toBe(0)
          const expected = variant === 'live' ? native : windows
          expect(expected.events.map(e => e.data.command), `output=${output}, native=${JSON.stringify(native.events)}, windows=${JSON.stringify(windows.events)}`).toContain('wsl-directory-probe')
          expect((variant === 'live' ? windows : native).events).toHaveLength(0)
        } finally { await native.close(); await windows.close() }
      }, 15_000)
    }
  }
})
