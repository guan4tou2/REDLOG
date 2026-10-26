import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }) })
const python = (() => { try { execFileSync('python3', ['--version']); return true } catch { return false } })()
const posix = describe.skipIf(!python || process.platform === 'win32')

function policy(app: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-origin-'))
  homes.push(dir)
  fs.writeFileSync(path.join(dir, 'terminal-app'), app)
  return dir
}
function check(app: string, env: Record<string, string> = {}): boolean {
  const result = execFileSync('python3', ['-c', `
import sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from terminal_app import terminal_app_allowed
# The OS cannot attest any origin. Environment variables must not replace it.
with patch('subprocess.run', side_effect=OSError('process observation denied')):
    print(terminal_app_allowed(sys.argv[2]))
`, path.resolve('hooks'), policy(app)], { encoding: 'utf8', env: { ...process.env, ...env } })
  return result.trim() === 'True'
}

posix('Terminal App policy uses observable origin, not self-declared hints', () => {
  it.each([
    ['WarpTerminal', { TERM_PROGRAM: 'WarpTerminal' }],
    ['WindowsTerminal', { WT_SESSION: 'forged', TERM_PROGRAM: '' }],
    ['WarpTerminal', { REDLOG_TERMINAL: '1', TERM_PROGRAM: 'Apple_Terminal' }]
  ] as Array<[string, Record<string, string>]>)('refuses %s when origin is unavailable', (app, env) => {
    expect(check(app, env)).toBe(false)
  })

  it('keeps explicit all-terminal capture available without origin introspection', () => {
    expect(check('all', { TERM_PROGRAM: '' })).toBe(true)
  })

  it('does not use a built-in flag to widen a corrupt preference', () => {
    expect(check('broken', { REDLOG_TERMINAL: '1' })).toBe(false)
  })
  it('attests a stable bundle lineage and rejects reparenting, tmux and an unrelated GUI boundary', () => {
    const result = execFileSync('python3', ['-c', `
import sys, tempfile, pathlib, plistlib, json
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import terminal_app as gate
with tempfile.TemporaryDirectory() as temp:
    app = pathlib.Path(temp) / 'Warp.app'
    binary = app / 'Contents' / 'MacOS' / 'stable'
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b'fixture executable identity')
    info = app / 'Contents' / 'Info.plist'
    info.write_bytes(plistlib.dumps({'CFBundleIdentifier': 'dev.warp.Warp-Stable', 'CFBundleExecutable': 'stable'}))
    runtime = pathlib.Path(temp) / 'Python.app' / 'Contents' / 'MacOS' / 'Python'
    runtime.parent.mkdir(parents=True)
    runtime.write_bytes(b'fixture runtime')
    (runtime.parent.parent / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'org.python.python', 'CFBundleExecutable': 'Python'}))
    table = {1000: (1100, 'birth-python', str(runtime)),
             1100: (1200, 'birth-shell', '/bin/zsh'),
             1200: (1, 'birth-app', str(binary))}
    def resolve(first, second=None):
        with patch.object(gate.sys, 'platform', 'darwin'), patch.object(gate.os, 'getpid', return_value=1000), patch.object(gate, '_process_table', side_effect=[first, second or first]):
            return gate.terminal_origin()
    good = resolve(table)
    changed = dict(table); changed[1100] = (1300, 'new-birth', '/bin/zsh')
    reused = resolve(table, changed)
    mux = dict(table); mux[1100] = (1200, 'birth-mux', '/opt/bin/tmux')
    blocked = resolve(mux)
    info.write_bytes(plistlib.dumps({'CFBundleIdentifier': 'com.unrelated.editor', 'CFBundleExecutable': 'stable'}))
    unrelated = resolve(table)
    print(json.dumps([good, reused, blocked, unrelated]))
`, path.resolve('hooks')], { encoding: 'utf8' })
    expect(JSON.parse(result)).toEqual(['WarpTerminal', null, null, null])
  })

})
