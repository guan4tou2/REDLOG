// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDiagnosticOutput } from '../src/core/wsl-manager'
import WslPanel from '../src/renderer/src/components/WslPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

// #433: the panel renders whatever the parser produced. The parser was reading
// a format the script never emits, so a `✗` line was rendered as a green `+`.
// The parser's own test pins the format; this one pins that the panel shows the
// status the parser assigned — a failure is a failure on screen, not a colour
// that only the parser knew about.

const t = (k: string): string => k

function draw(checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }>) {
  const distro = {
    name: 'kali', state: 'Running', version: 2, isDefault: false, shells: ['bash'],
    hookStatus: { bash: 'installed', zsh: 'no-shell' }
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    wsl: {
      listDistros: async () => [distro],
      getNetworkMode: async () => 'mirrored',
      installHook: vi.fn(),
      uninstallHook: vi.fn(),
      runDiagnostics: async () => ({ distro: 'kali', checks })
    }
  }
  render(<I18nProvider><WslPanel t={t} /></I18nProvider>)
}

/** The panel shows nothing until Diagnose runs; the failure this issue is
 *  about is in what it renders after. */
async function diagnose(): Promise<void> {
  fireEvent.click(await screen.findByText('settings.wsl.diagnose'))
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('WSL diagnostics panel', () => {
  it('renders a failed check as failed, with its message', async () => {
    const raw = readFileSync(join(__dirname, 'fixtures/wsl-diagnostics-output.txt'), 'utf8')
    const checks = parseDiagnosticOutput(raw)
    draw(checks)
    await diagnose()
    const failed = await screen.findByTestId('wsl-check-fail')
    expect(failed.textContent).toContain('Failed to send test event')
    expect(failed.textContent).toContain('connection reset')
    // The accessible name says the status; the glyph alone does not.
    expect(failed.textContent).toContain('settings.wsl.status.fail')
  })

  it('renders passes and warnings as their own statuses', async () => {
    const raw = readFileSync(join(__dirname, 'fixtures/wsl-diagnostics-output.txt'), 'utf8')
    draw(parseDiagnosticOutput(raw))
    await diagnose()
    expect((await screen.findAllByTestId('wsl-check-pass')).length).toBeGreaterThanOrEqual(6)
    expect(screen.getAllByTestId('wsl-check-warn').length).toBeGreaterThanOrEqual(1)
  })

  it('shows no raw ANSI escapes from the script output', async () => {
    const raw = readFileSync(join(__dirname, 'fixtures/wsl-diagnostics-output.txt'), 'utf8')
    draw(parseDiagnosticOutput(raw))
    await diagnose()
    await screen.findByTestId('wsl-check-fail')
    expect(document.body.textContent).not.toContain('\x1b')
  })
})
