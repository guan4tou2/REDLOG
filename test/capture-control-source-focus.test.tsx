// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import CaptureControlPage from '../src/renderer/src/components/settings/CaptureControlPage'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

// #590: a link that names a source lands on that source's row — the row is
// focused (and scrolled to), not just on the same page.

const agent = { agentKind: 'claude-code', pluginId: 'official-ai-claude-code', name: 'Claude Code', state: 'installed', installationId: 'i1' }
const config = { engagement: { id: 'p1' }, packs: { hostMonitors: true }, packMembers: {}, screenshot: {}, agentTailer: { sources: {} } } as unknown as ConfigState

function stubBridge(): void {
  Object.assign(window, { redlog: {
    platform: 'linux',
    plugins: { officialAgents: async () => [agent], list: async () => [
      { id: 'official-ai-claude-code', status: 'active', source: 'bundled' }, { id: 'pack-host-monitors', status: 'active', source: 'bundled' }
    ] },
    agents: { sources: async () => [{ id: 'claude-code', label: 'Claude Code', root: '/x', detected: true }], sessions: async () => [] },
    capture: { health: async () => ({ sources: [] }) },
    hooks: { detect: async () => [] },
    events: { onNewBatch: () => () => {} }
  } })
  Element.prototype.scrollIntoView = vi.fn()
}

function page(focusSource: string | null, onFocusHandled = vi.fn()): ReturnType<typeof render> {
  return render(<I18nProvider><CaptureControlPage config={config} setConfig={() => {}} t={k => k} focusSource={focusSource} onFocusHandled={onFocusHandled} /></I18nProvider>)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('Capture sources page: landing on a source row', () => {
  it('focuses the screenshot group for the screenshot source', async () => {
    stubBridge()
    const onFocusHandled = vi.fn()
    const { container } = page('screenshot', onFocusHandled)
    const row = container.querySelector<HTMLElement>('[data-source-id="screenshot"]')!
    await waitFor(() => expect(document.activeElement).toBe(row))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(onFocusHandled).toHaveBeenCalled()
  })

  it('focuses the agent row for agent-<kind> once the catalog has loaded', async () => {
    stubBridge()
    const onFocusHandled = vi.fn()
    const { container } = page('agent-claude-code', onFocusHandled)
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[data-source-id="agent-claude-code"]')))
    expect(document.activeElement?.getAttribute('data-testid')).toBe('agent-source-claude-code')
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
  })

  it('focuses a host-monitor member row', async () => {
    stubBridge()
    const { container } = page('file-watcher')
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[data-source-id="file-watcher"]')))
  })

  // #557: a jump per group, in page order, each scrolling to its own group.
  it('jumps to each of the four groups', async () => {
    stubBridge()
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
    const { container, getByTestId } = page(null)
    const buttons = Array.from(container.querySelectorAll('nav button')).map(b => b.getAttribute('data-testid'))
    expect(buttons).toEqual(['capture-jump-agents', 'capture-jump-screenshot', 'capture-jump-hostMonitors', 'capture-jump-external'])
    for (const id of ['agents', 'screenshot', 'hostMonitors']) fireEvent.click(getByTestId(`capture-jump-${id}`))
    // `t` is the identity here, so a group's title is its key.
    expect(scrolled[0]!.textContent).toContain('settings.agents')
    expect(scrolled[1]).toBe(container.querySelector('[data-source-id="screenshot"]'))
    expect(scrolled[2]!.textContent).toContain('settings.packHostMonitors')
    expect(scrolled).toHaveLength(3)
    cleanup()
  })

  it('does not move focus when no source is named', async () => {
    stubBridge()
    const onFocusHandled = vi.fn()
    page(null, onFocusHandled)
    await new Promise(r => setTimeout(r, 50))
    expect(document.activeElement).toBe(document.body)
    expect(onFocusHandled).not.toHaveBeenCalled()
  })
})
