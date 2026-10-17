import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stopOpenTerminals } from '../src/core/hook-removal'
import { writeTerminalEnrollment, readTerminalEnrollment, beginTerminal } from '../src/core/terminal-enrollment'

// Removing the shell hook edits the rc file, which only new shells read. A
// terminal that was already open has the hook loaded and kept recording, while
// the app said the hook was removed. Removal now stops those terminals too,
// through the same per-terminal state file `redlog stop` uses.

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-removal-')) })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const put = (sessionId: string, over: { recording?: boolean } = {}): void => {
  const s = beginTerminal({ sessionId, mode: 'auto', engagementId: 'e', operatorId: 'o' })
  writeTerminalEnrollment(home, { ...s, recording: over.recording ?? true })
}
const alive = (map: Record<number, string>) => (pid: number): string | null => map[pid] ?? null

describe('stopOpenTerminals', () => {
  it('stops a live zsh terminal and records why', () => {
    put('1792255597960919000-18140-7246')
    const r = stopOpenTerminals('zsh', { home, shellOf: alive({ 18140: 'zsh' }), platform: 'darwin' })
    expect(r.stopped).toBe(1)
    expect(readTerminalEnrollment(home, '1792255597960919000-18140-7246')).toMatchObject({ recording: false, stoppedReason: 'hook-removed' })
  })

  it('treats a login shell name (-zsh) as zsh', () => {
    put('1792255597960919000-18140-7246')
    expect(stopOpenTerminals('zsh', { home, shellOf: alive({ 18140: '-zsh' }), platform: 'darwin' }).stopped).toBe(1)
  })

  it('leaves a bash terminal alone when the zsh hook is removed', () => {
    put('1792255597960919000-200-1')
    expect(stopOpenTerminals('zsh', { home, shellOf: alive({ 200: 'bash' }), platform: 'darwin' }).stopped).toBe(0)
    expect(readTerminalEnrollment(home, '1792255597960919000-200-1')?.recording).toBe(true)
  })

  it('leaves a terminal whose process is gone, and RedLog\'s own built-in terminals', () => {
    put('1792255597960919000-300-1')           // pid 300 no longer exists
    put('term-1')                                // a built-in terminal id, not a hook id
    expect(stopOpenTerminals('zsh', { home, shellOf: alive({}), platform: 'darwin' }).stopped).toBe(0)
    expect(readTerminalEnrollment(home, 'term-1')?.recording).toBe(true)
  })

  it('does not rewrite a terminal that already stopped', () => {
    put('1792255597960919000-18140-7246', { recording: false })
    expect(stopOpenTerminals('zsh', { home, shellOf: alive({ 18140: 'zsh' }), platform: 'darwin' }).stopped).toBe(0)
  })

  it('does nothing without a state directory, and on Windows', () => {
    expect(stopOpenTerminals('zsh', { home, shellOf: alive({}), platform: 'darwin' }).stopped).toBe(0)
    put('1792255597960919000-18140-7246')
    expect(stopOpenTerminals('zsh', { home, shellOf: alive({ 18140: 'zsh' }), platform: 'win32' }).stopped).toBe(0)
  })
})
