// @vitest-environment jsdom
//
// Spec 036 UI: the first-launch readiness card and the legacy-hook migration
// banner, rendered against a mocked `runtime.preflight()` (W1's contract in
// src/core/runtime-preflight.ts). Nothing here may block entering the app: a
// missing python3 explains itself and still lets the operator continue.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { RuntimeReadinessHost, LegacyHookBanner } from '../src/renderer/src/components/RuntimeReadiness'
import { openRuntimeReadiness } from '../src/renderer/src/lib/runtimeReadiness'

type Check = { id: string; found: boolean; neededFor: string[]; remediation?: string }
type Ref = { file: string; line: number; text: string; hookId: string | null }

function preflight(over: { checks?: Check[]; legacyHooks?: Ref[] } = {}): unknown {
  return {
    platform: 'linux',
    shell: { name: 'zsh', hookId: 'shell-zsh' },
    checks: over.checks ?? [
      { id: 'python3', found: true, neededFor: ['shell-zsh', 'shell-bash'] },
      { id: 'curl', found: true, neededFor: ['shell-zsh', 'shell-bash'] },
      { id: 'zsh', found: true, neededFor: ['shell-zsh'] },
      { id: 'bash', found: true, neededFor: ['shell-bash'] },
      { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
    ],
    legacyHooks: over.legacyHooks ?? []
  }
}

const LEGACY: Ref = { file: '/home/op/.zshrc', line: 3, text: 'source ~/.redlog/shell-preexec-hook.sh', hookId: 'shell-zsh' }

let pf: ReturnType<typeof vi.fn>
let migrate: ReturnType<typeof vi.fn>
let copy: ReturnType<typeof vi.fn>

function mount(ui: JSX.Element): void {
  render(<I18nProvider>{ui}</I18nProvider>)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('redlog-locale', 'zh-TW')
  pf = vi.fn(async () => preflight())
  migrate = vi.fn(async () => ({ success: true, message: 'ok', backupPath: '/home/op/.zshrc.redlog-bak-1700000000000', removed: 1, hookId: 'shell-zsh' }))
  copy = vi.fn(async () => true)
  ;(window as unknown as { redlog: unknown }).redlog = {
    runtime: { preflight: pf },
    hooks: { migrateLegacy: migrate },
    clipboard: { writeText: copy, readText: async () => '' }
  }
})
afterEach(() => cleanup())

describe('first-launch readiness', () => {
  it('missing python3 shows the remediation and still lets the operator continue', async () => {
    pf.mockResolvedValue(preflight({
      checks: [
        { id: 'python3', found: false, neededFor: ['shell-zsh', 'shell-bash'], remediation: 'sudo apt install python3' },
        { id: 'curl', found: true, neededFor: ['shell-zsh', 'shell-bash'] },
        { id: 'zsh', found: true, neededFor: ['shell-zsh'] },
        { id: 'bash', found: true, neededFor: ['shell-bash'] },
        { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
      ]
    }))
    mount(<RuntimeReadinessHost firstLaunch />)
    await screen.findByText('RedLog 準備狀態')
    expect(screen.getByText('sudo apt install python3')).toBeTruthy()
    // This used to pin the claim that the built-in terminal still records.
    // It does not record COMMANDS: it sources the same POSIX adapter an
    // external shell does, and that adapter needs python3 and curl. What it
    // must say now is what stops working, and that the built-in terminal is
    // not an exception.
    const note = screen.getByTestId('readiness-runtime-missing').textContent ?? ''
    expect(note).toContain('時間軸')
    expect(note).toContain('adapter')
    expect(note).not.toContain('內建終端仍可記錄')
    // re-check probes again
    fireEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    await waitFor(() => expect(pf).toHaveBeenCalledTimes(2))
    // continuing is never blocked
    const start = screen.getByRole('button', { name: '開始使用' })
    expect((start as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(start)
    expect(screen.queryByText('RedLog 準備狀態')).toBeNull()
  })

  it('shows missing mitmproxy as optional with a copyable install command', async () => {
    pf.mockResolvedValue(preflight({
      checks: [
        { id: 'python3', found: true, neededFor: [] },
        { id: 'curl', found: true, neededFor: [] },
        { id: 'zsh', found: true, neededFor: [] },
        { id: 'mitmdump', found: false, neededFor: ['mitmproxy'], remediation: 'uv tool install mitmproxy' }
      ]
    }))
    mount(<RuntimeReadinessHost firstLaunch />)
    // HTTP(S) capture is a core capability with an optional runtime, not an
    // optional integration: it sits in its own named group beside command
    // capture, and the copy that goes with it says when it is needed rather
    // than that it is secondary.
    await screen.findByText(/HTTP\(S\) 擷取/)
    await screen.findByText(/做 Web 測試時需要/)
    expect(screen.queryByText(/要記錄你自己的終端需要 python3 與 curl/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /uv tool install mitmproxy/ }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith('uv tool install mitmproxy'))
  })

  it('is not shown again after dismissal, but can be reopened', async () => {
    mount(<RuntimeReadinessHost firstLaunch />)
    fireEvent.click(await screen.findByRole('button', { name: '開始使用' }))
    cleanup()
    mount(<RuntimeReadinessHost firstLaunch />)
    await Promise.resolve()
    expect(screen.queryByText('RedLog 準備狀態')).toBeNull()
    openRuntimeReadiness()
    await screen.findByText('RedLog 準備狀態')
  })

  it('does not appear inside a project unless reopened', async () => {
    mount(<RuntimeReadinessHost firstLaunch={false} />)
    await Promise.resolve()
    expect(screen.queryByText('RedLog 準備狀態')).toBeNull()
  })
})

describe('legacy hook banner', () => {
  it('stays hidden when no legacy hook is sourced', async () => {
    mount(<LegacyHookBanner />)
    await waitFor(() => expect(pf).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: '更新 Zsh hook' })).toBeNull()
  })

  it('migrates the reported ref and shows the backup path', async () => {
    pf.mockResolvedValueOnce(preflight({ legacyHooks: [LEGACY] })).mockResolvedValue(preflight())
    mount(<LegacyHookBanner />)
    await screen.findByText(/仍在載入舊版 RedLog hook，升級後不會再產生事件/)
    expect(screen.getByText(/~\/\.zshrc/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更新 Zsh hook' }))
    await waitFor(() => expect(migrate).toHaveBeenCalledWith(LEGACY))
    await screen.findByText(/\/home\/op\/\.zshrc\.redlog-bak-1700000000000/)
    expect(screen.getByText(/開啟新的終端/)).toBeTruthy()
  })

  it('shows the reason when migration fails', async () => {
    pf.mockResolvedValue(preflight({ legacyHooks: [LEGACY] }))
    migrate.mockResolvedValue({ success: false, message: 'EACCES: permission denied', removed: 0, hookId: 'shell-zsh' })
    mount(<LegacyHookBanner />)
    fireEvent.click(await screen.findByRole('button', { name: '更新 Zsh hook' }))
    await screen.findByText(/EACCES: permission denied/)
  })
})
