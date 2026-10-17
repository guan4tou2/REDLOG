// @vitest-environment jsdom
//
// Manual adapter selection in the onboarding record-terminal flow.
//
// Spec 037 fixed the login shell as the one to hook: preflight answered with
// `$SHELL` and the flow installed exactly that adapter. That is right as a
// *recommendation* and wrong as a decision — an operator with zsh as their
// login shell but who works in bash had no way to say so, and the only signal
// that a hook belongs to the wrong shell was a timeout that named nothing
// about it.
//
// This suite is the observable contract for the fix:
//
//   * the detected adapter is shown and *recommended*, not forced;
//   * a manual choice replaces it and governs install id, prerequisites and
//     canary matching, so an event from the other shell cannot mark connected;
//   * a slow install from the abandoned selection cannot overwrite the new one;
//   * an adapter the backend reports unavailable is not installed to look
//     connected, and its own missing prerequisite blocks only itself.
//
// The event stream and preflight are mocked, as in the first-run suite; the
// locale is pinned to zh-TW.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { RecordTerminalFlow, type RecordTarget } from '../src/renderer/src/components/RecordTerminalFlow'

type Ev = { id: string; timestamp: number; agentType: string; data: Record<string, unknown> }

interface Hook {
  id: string
  name: string
  description: string
  agentType: string
  installed: boolean
  available: boolean
  installMethod: 'claude-settings' | 'shell-source' | 'powershell-profile' | 'manual'
  hookFile: string
}

const ZSH: Hook = { id: 'shell-zsh', name: 'Zsh Shell', description: '', agentType: 'shell', installed: false, available: true, installMethod: 'shell-source', hookFile: '/x/shell-zsh-hook.zsh' }
const BASH: Hook = { id: 'shell-bash', name: 'Bash Shell', description: '', agentType: 'shell', installed: false, available: true, installMethod: 'shell-source', hookFile: '/x/shell-bash-hook.sh' }

function hostHook(id: string, available: boolean, installed = false): Hook {
  return { id, name: id, description: '', agentType: 'shell', installed, available, installMethod: 'shell-source', hookFile: `/x/${id}` }
}

function preflight(over: Partial<RuntimePreflight> = {}): RuntimePreflight {
  return {
    platform: 'darwin',
    shell: over.shell === undefined ? { name: 'zsh', hookId: 'shell-zsh' } : over.shell,
    checks: over.checks ?? [
      { id: 'python3', found: true, neededFor: ['shell-zsh', 'shell-bash'] },
      { id: 'curl', found: true, neededFor: ['shell-zsh', 'shell-bash'] },
      { id: 'zsh', found: true, neededFor: ['shell-zsh'] },
      { id: 'bash', found: true, neededFor: ['shell-bash'] },
      { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
    ]
  }
}

let listeners: Array<(evs: Ev[]) => void>
let bridge: {
  preflight: ReturnType<typeof vi.fn>
  detect: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
}

function install(opts: {
  pre?: RuntimePreflight
  hooks?: Hook[]
  platform?: string
  install?: (id: string) => Promise<{ success: boolean; message: string }>
} = {}): void {
  listeners = []
  bridge = {
    preflight: vi.fn(async () => opts.pre ?? preflight()),
    detect: vi.fn(async () => opts.hooks ?? [ZSH, BASH]),
    install: vi.fn(opts.install ?? (async () => ({ success: true, message: 'ok' })))
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: opts.platform ?? 'darwin',
    runtime: { preflight: bridge.preflight },
    hooks: { detect: bridge.detect, install: bridge.install },
    events: {
      onNewBatch: (cb: (evs: Ev[]) => void) => {
        listeners.push(cb)
        return () => { listeners = listeners.filter((l) => l !== cb) }
      }
    }
  }
}

const ZSH_TARGET: RecordTarget = { kind: 'host', hookId: 'shell-zsh', label: 'Zsh' }
const BASH_TARGET: RecordTarget = { kind: 'host', hookId: 'shell-bash', label: 'Bash' }

function draw(target: RecordTarget = ZSH_TARGET): void {
  render(
    <I18nProvider>
      <RecordTerminalFlow target={target} onPrepare={vi.fn()} />
    </I18nProvider>
  )
}

const emit = (evs: Ev[]): void => {
  act(() => { for (const l of listeners) l(evs) })
}

/** The nonce command this attempt is showing now. */
async function commandText(): Promise<string> {
  return (await screen.findByTestId('record-terminal-command')).textContent ?? ''
}

beforeEach(() => { localStorage.setItem('redlog-locale', 'zh-TW') })
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear() })

describe('record my terminal: adapter selection', () => {
  it('shows the detected shell as recommended and installs the manual choice instead', async () => {
    install()
    draw()
    const zsh = await screen.findByTestId('record-terminal-adapter-shell-zsh')
    expect(zsh.getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('record-terminal-adapter-detected-shell-zsh')).toBeTruthy()
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-zsh'))

    fireEvent.click(screen.getByTestId('record-terminal-adapter-shell-bash'))
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-bash'))
    expect(bridge.install.mock.calls.at(-1)).toEqual(['shell-bash'])
    expect(screen.getByTestId('record-terminal-adapter-shell-bash').getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('record-terminal-adapter-shell-zsh').getAttribute('data-selected')).toBe('false')
  })

  it('never lets the other adapter\'s canary mark the selection connected', async () => {
    install()
    draw()
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-zsh'))
    fireEvent.click(screen.getByTestId('record-terminal-adapter-shell-bash'))
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-bash'))
    const cmd = await commandText()
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0))

    // A zsh hook event: this selection is bash, so it proves nothing.
    emit([{ id: 'z', timestamp: 2, agentType: 'shell', data: { subtype: 'command_end', shell: 'zsh', command: cmd } }])
    expect(screen.queryByTestId('record-terminal-verified')).toBeNull()

    emit([{ id: 'b', timestamp: 3, agentType: 'shell', data: { subtype: 'command_end', shell: 'bash', command: cmd } }])
    expect((await screen.findByTestId('record-terminal-verified')).textContent).toContain('Bash')
  })

  it('a slow install from the abandoned selection cannot replace the new one', async () => {
    let resolveZsh: ((r: { success: boolean; message: string }) => void) | null = null
    install({
      install: (id) => id === 'shell-zsh'
        ? new Promise((resolve) => { resolveZsh = resolve })
        : Promise.resolve({ success: true, message: 'ok' })
    })
    draw()
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-zsh'))

    fireEvent.click(screen.getByTestId('record-terminal-adapter-shell-bash'))
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-bash'))
    const bashCommand = await commandText()

    // The abandoned attempt finally reports success. It must not flip this
    // selection into "installed" — or hand it the wrong shell's nonce.
    act(() => { resolveZsh?.({ success: true, message: 'ok' }) })
    await act(async () => {})
    expect(await commandText()).toBe(bashCommand)
    expect(screen.getByTestId('record-terminal-flow').getAttribute('data-phase')).toBe('waiting-for-activation')
  })

  it('blocks the selected adapter on its own prerequisite, and another adapter is still installable', async () => {
    install({
      pre: preflight({
        shell: { name: 'bash', hookId: 'shell-bash' },
        checks: [
          { id: 'python3', found: false, neededFor: ['shell-bash'], remediation: 'brew install python' },
          { id: 'curl', found: true, neededFor: ['shell-zsh', 'shell-bash'] },
          { id: 'zsh', found: true, neededFor: ['shell-zsh'] },
          { id: 'bash', found: true, neededFor: ['shell-bash'] },
          { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
        ]
      })
    })
    draw(BASH_TARGET)
    const blocked = await screen.findByTestId('record-terminal-missing')
    expect(blocked.textContent).toContain('python3')
    expect(bridge.install).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('record-terminal-adapter-shell-zsh'))
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-zsh'))
  })

  it('does not install an adapter the backend reports unavailable', async () => {
    install({ hooks: [hostHook('shell-zsh', false), hostHook('shell-bash', true)] })
    draw()
    const unavailable = await screen.findByTestId('record-terminal-unavailable')
    expect(unavailable.textContent).toContain('Zsh')
    const zsh = screen.getByTestId('record-terminal-adapter-shell-zsh')
    expect(zsh.getAttribute('data-available')).toBe('false')
    expect((zsh as HTMLButtonElement).disabled).toBe(true)
    expect(bridge.install).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('record-terminal-adapter-shell-bash'))
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-bash'))
  })

  it('a failed install can be retried and then reaches the wait for the nonce', async () => {
    let first = true
    install({
      install: async () => {
        if (first) { first = false; return { success: false, message: 'copy failed' } }
        return { success: true, message: 'ok' }
      }
    })
    draw()
    const failed = await screen.findByTestId('record-terminal-install-failed')
    expect(failed.textContent).toContain('copy failed')
    fireEvent.click(screen.getByText('再試一次'))
    await waitFor(() => expect(bridge.install).toHaveBeenCalledTimes(2))
    expect(await commandText()).toMatch(/^echo redlog-ok-[a-z0-9]{4,}$/)
  })
})

it('does not install when detection fails, and can retry detection', async () => {
  install(); bridge.detect.mockRejectedValueOnce(new Error('detect unavailable')); draw()
  const failure = await screen.findByTestId('record-terminal-detect-failed')
  expect(bridge.install).not.toHaveBeenCalled()
  fireEvent.click(failure.querySelector('button')!)
  await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-zsh'))
})

it('does not accept a canary without observed shell identity', async () => {
  install(); draw(); const command = await commandText()
  emit([{ id: 'unidentified', timestamp: 1, agentType: 'shell', data: { subtype: 'command_end', command } }])
  expect(screen.queryByTestId('record-terminal-verified')).toBeNull()
})

it('PowerShell editions are alternatives rather than two required tools', async () => {
  install({ platform: 'win32', pre: preflight({ platform: 'win32', shell: { name: 'powershell', hookId: 'shell-powershell' }, checks: [
    { id: 'powershell', found: true, neededFor: ['shell-powershell'] }, { id: 'pwsh', found: false, neededFor: ['shell-powershell'] }
  ] }), hooks: [hostHook('shell-powershell', true)] })
  draw({ kind: 'host', hookId: 'shell-powershell', label: 'PowerShell' })
  await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-powershell'))
  expect(await commandText()).toMatch(/^Write-Output redlog-ok-/)
})

it('a WSL canary must identify the selected distro, not a host or another distro', async () => {
  install()
  Object.assign(window.redlog, { wsl: { installHook: vi.fn(async () => ({ success: true, message: 'ok' })) } })
  draw({ kind: 'wsl', shell: 'zsh', distro: 'Ubuntu', label: 'WSL Ubuntu' })
  const command = await commandText()
  for (const wsl_distro of [undefined, 'Kali']) {
    emit([{ id: 'wrong', timestamp: 1, agentType: 'shell', data: { subtype: 'command_end', command, shell: 'zsh', wsl_distro } }])
    expect(screen.queryByTestId('record-terminal-verified')).toBeNull()
  }
  emit([{ id: 'right', timestamp: 1, agentType: 'shell', data: { subtype: 'command_end', command, shell: 'zsh', wsl_distro: 'Ubuntu' } }])
  expect(await screen.findByTestId('record-terminal-verified')).toBeTruthy()
})
