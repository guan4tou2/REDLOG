// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import AgentsPanel from '../src/renderer/src/components/settings/AgentsPanel'

vi.mock('../src/renderer/src/components/settings/CapturePackGroup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/components/settings/CapturePackGroup')>()),
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

describe('AI tools: one switch each, with what is on this machine', () => {
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

  it('gives each tool its own switch, on until the operator turns it off', async () => {
    bridge([])
    const setConfig = vi.fn()
    render(<AgentsPanel t={t} config={{ packMembers: { codex: false } } as never} setConfig={setConfig} />)
    await screen.findByTestId('agent-source-claude-code')
    expect((screen.getByTestId('pack-member-claudeCode') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('pack-member-codex') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByTestId('pack-member-claudeCode'))
    expect(setConfig).toHaveBeenCalledWith({ packMembers: { codex: false, claudeCode: false } })
  })
})
