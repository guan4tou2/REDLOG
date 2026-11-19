import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const python = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' }).status === 0

for (const shell of ['bash', 'zsh'] as const) {
  const available = python && spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
  const hook = path.resolve(`hooks/shell-${shell}-hook.${shell === 'zsh' ? 'zsh' : 'sh'}`)
  const run = (body: string, identity?: { engagementId: string; operatorId: string }): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-shell-status-'))
    const dir = path.join(home, '.redlog')
    fs.mkdirSync(dir)
    if (identity) fs.writeFileSync(path.join(dir, 'active-identity.json'), JSON.stringify(identity))
    try {
      const args = shell === 'zsh' ? ['-dfc'] : ['--noprofile', '--norc', '-c']
      // The hook finds the home above `_REDLOG_DIR` by its last `/`. In use that
      // directory comes from `$HOME`, which Git Bash spells with forward
      // slashes; a native Windows path here has none and points one level off.
      const posix = (p: string): string => p.split(path.sep).join('/')
      const result = spawnSync(shell, [...args, `source "$1"; ${body}`, 'redlog-status', hook], {
        encoding: 'utf8', timeout: 15_000,
        env: { PATH: process.env.PATH ?? '', HOME: posix(home), _REDLOG_DIR: posix(dir) }
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      return result.stdout
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  }

  ;(available ? describe : describe.skip)(`${shell} terminal status`, () => {
    it('does not promise recording just because the hook loaded', () => {
      const output = run('redlog status; redlog start; redlog mode auto; redlog status; :')
      expect(output).toContain('app not reachable')
      expect(output).toContain('open a project and a new terminal')
      expect(output).not.toMatch(/will be recorded|recording in this terminal|^recording /m)
    })

    it.each([
      ['', 'app not reachable', 1],
      ['{"ok":true,"projectOpen":false,"recording":false}', 'app running, no project open', 1],
      ['{"ok":true,"projectOpen":true,"recording":false}', 'recording paused', 1],
      ['{"ok":true,"projectOpen":true,"recording":true,"projectId":"status-project"}', 'recording into project status-project', 0]
    ])('reports the state returned by the app (%s)', (health, message, code) => {
      const output = run(`printf 6660 > "$HOME/.redlog/api-port"; curl() { printf '%s' '${health}'; }; redlog status; printf 'exit=%s\\n' "$?"`, {
        engagementId: 'status-project', operatorId: 'status-operator'
      })
      expect(output).toContain(message)
      expect(output).toContain(`exit=${code}`)
    })

    it('does not announce a resume or emit a resumed event after a project switch', () => {
      const output = run('_redlog_state --action project --engagement other-project >/dev/null; _redlog_send_event() { echo "EVENT:$1"; }; redlog start; redlog status; :', {
        engagementId: 'status-project', operatorId: 'status-operator'
      })
      expect(output).toContain('stopped (project-switched)')
      expect(output).not.toContain('recording in this terminal')
      expect(output).not.toContain('EVENT:capture_resumed')
    })
  })
}
