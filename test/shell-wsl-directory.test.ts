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
    for (const nativeAlive of [false, true]) {
      it(`${entry}: ${nativeAlive ? 'keeps a live native app' : 'does not let a stale native directory shadow the Windows app'}`, async () => {
        const native = await startCollector('native-token')
        const windows = await startCollector('windows-token')
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-wsl-directory-'))
        temporary.push(root)
        const home = path.join(root, 'native-home'), winHome = path.join(root, 'windows-home'), bin = path.join(root, 'bin')
        fs.mkdirSync(bin)
        for (const [dir, token, port] of [[home, 'native-token', nativeAlive ? native.port : 1], [winHome, 'windows-token', windows.port]] as const) {
          fs.mkdirSync(path.join(dir, '.redlog'), { recursive: true })
          fs.writeFileSync(path.join(dir, '.redlog', 'api-token'), token)
          fs.writeFileSync(path.join(dir, '.redlog', 'api-port'), String(port))
        }
        fs.writeFileSync(path.join(bin, 'cmd.exe'), `#!/bin/sh\nprintf '%s\\n' ${quote(winHome)}\n`, { mode: 0o755 })
        fs.writeFileSync(path.join(bin, 'wslpath'), '#!/bin/sh\nprintf "%s\\n" "$1"\n', { mode: 0o755 })
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, WSL_DISTRO_NAME: 'test-kali', REDLOG_SHELL: 'bash' }
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
          const expected = nativeAlive ? native : windows
          expect(expected.events.map(e => e.data.command), `output=${output}, native=${JSON.stringify(native.events)}, windows=${JSON.stringify(windows.events)}`).toContain('wsl-directory-probe')
          expect((nativeAlive ? windows : native).events).toHaveLength(0)
        } finally { await native.close(); await windows.close() }
      }, 15_000)
    }
  }
})
