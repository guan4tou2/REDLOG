import { describe, it, expect } from 'vitest'
import { wslEnvFor, WSL_FORWARDED_ENV } from '../src/main/terminal-manager'

// A WSL pane starts `wsl.exe`, and Windows environment variables do not cross
// that boundary unless they are named in WSLENV. Verified on Windows 11:
//
//   REDLOG_TERMINAL=1 wsl -d Ubuntu -- bash -lc 'echo [$REDLOG_TERMINAL]'
//   []
//   REDLOG_TERMINAL=1 WSLENV=REDLOG_TERMINAL wsl -d Ubuntu -- bash -lc '…'
//   [1]
//
// Without it the adapter inside the distro saw neither REDLOG_TERMINAL — so
// its events were never tagged `source: 'builtin-terminal'`, and a WSL pane
// read as silent on the capture panel — nor REDLOG_TERMINAL_ID, so a
// command_end could not be matched to the pane whose stdout it belongs to.
describe('wslEnvFor', () => {
  it('names everything the adapter and the proxy need inside the distro', () => {
    const entries = wslEnvFor(undefined).split(':')
    for (const name of WSL_FORWARDED_ENV) expect(entries).toContain(name)
  })

  it('keeps what the operator already had, flags and all', () => {
    const out = wslEnvFor('MY_TOKEN:REPO_PATH/p:BUILD_DIR/up')
    const entries = out.split(':')
    expect(entries).toContain('MY_TOKEN')
    expect(entries).toContain('REPO_PATH/p')
    expect(entries).toContain('BUILD_DIR/up')
    expect(entries).toContain('REDLOG_TERMINAL')
  })

  it('does not add a name the operator already listed, or change their flags', () => {
    // They chose path translation for this one; we must not shadow it with a
    // bare duplicate, and WSLENV takes the first entry for a name.
    const out = wslEnvFor('REDLOG_TERMINAL_ID/w:OTHER')
    expect(out.split(':').filter((e) => e.split('/')[0] === 'REDLOG_TERMINAL_ID')).toEqual(['REDLOG_TERMINAL_ID/w'])
  })

  it('produces no empty entries from a stray separator', () => {
    expect(wslEnvFor('::A::').split(':')).not.toContain('')
  })
})
