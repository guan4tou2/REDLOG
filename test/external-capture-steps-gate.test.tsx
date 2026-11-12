// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ExternalCaptureGroup from '../src/renderer/src/components/settings/ExternalCaptureGroup'
import { I18nProvider } from '../src/renderer/src/i18n'

// Settings ▸ Other capture sources reads two facts from core and no prose:
// which listed dependency is missing, and whether the plugin's commands may be
// shown (08-plugin-system F7).

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join('|')})` : key

const row = (over: Record<string, unknown>) => ({
  id: 'acme.run', name: 'Runner', agentType: 'scanner', installed: false, available: true, disabled: false,
  installMethod: 'manual', hookFile: '/p/hook.sh',
  description: 'needs tcpdump and node', manualSteps: [{ label: 'Start', command: 'sudo "/p/hook.sh" eth0' }], ...over
})

let detect: ReturnType<typeof vi.fn>
beforeEach(() => {
  detect = vi.fn()
  Object.assign(window, { redlog: { platform: 'linux', hooks: { detect }, capture: { health: async () => ({ sources: [{ id: 'acme.run', state: 'off', running: false }] }) } } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const draw = (onOpenPlugins?: () => void) =>
  render(<I18nProvider><ExternalCaptureGroup t={t} onOpenPlugins={onOpenPlugins} /></I18nProvider>)

describe('external capture rows', () => {
  it('names the missing dependency from the manifest\'s lists, not its description', async () => {
    detect.mockResolvedValue([row({ available: false, missing: ['redlog-tool-x'] })])
    draw()
    expect(await screen.findByText('settings.externalMissing(redlog-tool-x)')).toBeTruthy()
    expect(screen.queryByText(/tcpdump/)).toBeNull()
  })

  it('shows the approval state, and no command, while the plugin waits for approval', async () => {
    const open = vi.fn()
    detect.mockResolvedValue([row({ manualSteps: undefined, stepsWithheld: 'needs-consent' })])
    const { container } = draw(open)
    expect(await screen.findByText('plugins.issue.needsConsent')).toBeTruthy()
    expect(screen.getByText('settings.openPlugins')).toBeTruthy()
    expect(container.textContent).not.toContain('sudo')
    expect(container.querySelector('details')).toBeNull()
  })

  it('says a changed bundled file hides its commands, with nothing to approve', async () => {
    detect.mockResolvedValue([row({ manualSteps: undefined, stepsWithheld: 'bundled-changed' })])
    draw(vi.fn())
    expect(await screen.findByText('settings.externalBundledChanged')).toBeTruthy()
    expect(screen.queryByText('settings.openPlugins')).toBeNull()
  })
})
