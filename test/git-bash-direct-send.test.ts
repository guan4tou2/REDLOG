import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startCollector } from './helpers/zsh-pty'

// #345. Under Git for Windows the hook's curl is a native Windows program. It
// was handed the body as `@/tmp/x/payload.json`, and with MSYS_NO_PATHCONV=1
// nothing turned that MSYS path into one it could open: every POST failed and
// every event reached RedLog only through the spool, about 30 s late. The body
// now goes in on stdin. The shell tests that load the hook skip win32, so this
// is the one that runs the real Git Bash and asks how the event arrived.

const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(p => fs.existsSync(p))
const describeGitBash = process.platform === 'win32' && GIT_BASH ? describe : describe.skip
const TOKEN = 'git-bash-token'

let collector: Awaited<ReturnType<typeof startCollector>>
const homes: string[] = []
beforeAll(async () => { if (GIT_BASH) collector = await startCollector(TOKEN) })
afterAll(async () => { await collector?.close() })
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }) })

// Async, never spawnSync: the collector lives in this process, and a blocked
// event loop cannot answer the hook, which then times out into the spool.
async function send(env: Record<string, string>, command: string, sender: 'shell-common' | 'redlog-send' | 'redlog-agent' = 'shell-common'): Promise<{ home: string; status: number | null; stderr: string; ms: number }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-git-bash-'))
  homes.push(home)
  const redlog = path.join(home, '.redlog')
  fs.mkdirSync(redlog)
  fs.writeFileSync(path.join(redlog, 'api-port'), String(collector.port))
  fs.writeFileSync(path.join(redlog, 'api-token'), TOKEN)
  fs.writeFileSync(path.join(redlog, 'active-identity.json'), JSON.stringify({ engagementId: 'eng-345', operatorId: 'op-345' }))
  const repo = path.join(__dirname, '..').replace(/\\/g, '/')
  const hook = `${repo}/hooks/shell-common.sh`
  const started = Date.now()
  // `sender` swaps in another of the repository's shell senders; each carries
  // its own copy of how it hands curl the token (#489), and each must work here.
  const script = sender === 'redlog-send' ? `bash "${repo}/hooks/redlog-send.sh" "$1" command_start; wait`
    : sender === 'redlog-agent' ? `source "${repo}/shell/redlog-agent.sh" && _redlog_post /api/events "{\\"agent_type\\":\\"agent\\",\\"data\\":{\\"command\\":\\"$1\\"}}"`
    : `source "${hook}" && _redlog_send_event command_start "$1"`
  const child = spawn(GIT_BASH!, ['--noprofile', '--norc', '-c', script, 'bash', command], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env }
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  return { home, status, stderr, ms: Date.now() - started }
}

describeGitBash('Git Bash on Windows delivers hook events directly (#345)', () => {
  for (const [label, env] of [
    ['with path conversion on', {}],
    ['with MSYS_NO_PATHCONV=1', { MSYS_NO_PATHCONV: '1' }],
    ['with MSYS2_ARG_CONV_EXCL=*', { MSYS2_ARG_CONV_EXCL: '*' }]
  ] as const) {
    it(label, async () => {
      const from = collector.events.length
      const command = `echo git-bash-${label.replace(/\W+/g, '-')}`
      const { home, status, stderr } = await send(env, command)
      expect(status, stderr).toBe(0)
      expect(collector.events.slice(from).map(e => e.data.command)).toContain(command)
      const pending = path.join(home, '.redlog', 'pending')
      expect(fs.existsSync(pending) ? fs.readdirSync(pending) : []).toEqual([])
      // The token reached curl as a config file (#489), and none is left holding it.
      const redlog = path.join(home, '.redlog')
      for (const name of fs.readdirSync(redlog).filter(n => n.startsWith('.curl-auth.'))) {
        expect(fs.readFileSync(path.join(redlog, name), 'utf8'), name).toBe('')
      }
    })
  }

  // The collector answers 401 to a wrong or missing token, so an event that
  // arrives is one whose token reached curl through the config file.
  for (const sender of ['redlog-send', 'redlog-agent'] as const) {
    it(`${sender} authenticates with MSYS_NO_PATHCONV=1`, async () => {
      const from = collector.events.length
      const command = `echo git-bash-${sender}`
      const { status, stderr } = await send({ MSYS_NO_PATHCONV: '1' }, command, sender)
      expect(status, stderr).toBe(0)
      // redlog-send.sh posts in the background; give it the time it needs.
      for (let i = 0; i < 50 && !collector.events.slice(from).some(e => e.data.command === command); i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(collector.events.slice(from).map(e => e.data.command)).toContain(command)
    })
  }
})
