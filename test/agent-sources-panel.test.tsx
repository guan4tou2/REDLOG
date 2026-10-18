// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import AgentsPanel from '../src/renderer/src/components/settings/AgentsPanel'

vi.mock('../src/renderer/src/components/settings/CapturePackGroup', () => ({
  default: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  usePackAvailability: () => null
}))

const t = (key: string, vars?: Record<string, string | number>): string => vars ? `${key}:${JSON.stringify(vars)}` : key

function bridge(watchPaths: string[]): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    agents: {
      sources: async () => [
        { id: 'claude-code', label: 'Claude Code', root: '/h/.claude/projects', detected: true },
        { id: 'codex', label: 'Codex CLI', root: '/h/.codex/sessions', detected: false }
      ]
    },
    hookConfig: { get: async () => ({ excludedPaths: [], watchPaths }), save: async () => true, pickPath: async () => null }
  }
}

describe('AI capture: what can be read, shown where it is turned on', () => {
  afterEach(cleanup)

  it('says which tools exist on this machine and where they are read from', async () => {
    bridge([])
    render(<AgentsPanel t={t} config={{} as never} setConfig={() => {}} />)
    const claude = await screen.findByTestId('agent-source-claude-code')
    expect(claude.getAttribute('data-detected')).toBe('true')
    expect(claude.textContent).toContain('/h/.claude/projects')
    expect(screen.getByTestId('agent-source-codex').getAttribute('data-detected')).toBe('false')
  })

  it('says an empty folder list means every discovered session', async () => {
    bridge([])
    render(<AgentsPanel t={t} config={{} as never} setConfig={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('agent-scope').textContent).toBe('settings.agents.scopeAll'))
  })

  it('says how many folders limit it once some are set', async () => {
    bridge(['/work/a', '/work/b'])
    render(<AgentsPanel t={t} config={{} as never} setConfig={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('agent-scope').textContent).toContain('"n":2'))
  })
})
