import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { debugLog, debugLogPath, isDebugLogEnabled, setDebugLogEnabled } from '../src/core/debug-log'

// The debug log is something an operator attaches to a bug report, so the two
// properties that matter are that it is silent until asked and that turning it
// off leaves nothing behind that still records.

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-debuglog-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('debug log', () => {
  it('is off by default and writes nothing', () => {
    expect(isDebugLogEnabled()).toBe(false)
    debugLog('hooks', 'install', 'id=shell-zsh')
    expect(fs.existsSync(debugLogPath())).toBe(false)
  })

  it('records area, event and detail once switched on, and stops when switched off', () => {
    setDebugLogEnabled(true)
    expect(isDebugLogEnabled()).toBe(true)
    debugLog('httpCapture', 'stop', 'staleTerminals=2')
    setDebugLogEnabled(false)
    expect(isDebugLogEnabled()).toBe(false)
    debugLog('hooks', 'install', 'after-off')
    const lines = fs.readFileSync(debugLogPath(), 'utf8').trim().split('\n')
    expect(lines.map(l => l.replace(/^\S+ /, ''))).toEqual([
      'app debug-log-on',
      'httpCapture stop staleTerminals=2',
      'app debug-log-off'
    ])
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /)
  })

  it('keeps one rotated file instead of growing without bound', () => {
    setDebugLogEnabled(true)
    fs.writeFileSync(debugLogPath(), 'x'.repeat(2 * 1024 * 1024 + 1))
    debugLog('app', 'after-rotation')
    expect(fs.statSync(`${debugLogPath()}.1`).size).toBeGreaterThan(2 * 1024 * 1024)
    expect(fs.readFileSync(debugLogPath(), 'utf8')).toContain('app after-rotation')
  })

  it('never throws, even when the log cannot be written', () => {
    setDebugLogEnabled(true)
    fs.rmSync(debugLogPath(), { force: true })
    fs.mkdirSync(debugLogPath()) // a directory where the file should be
    expect(() => debugLog('app', 'unwritable')).not.toThrow()
  })
})
