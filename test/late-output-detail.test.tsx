// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CommandEndDetail } from '../src/renderer/src/components/TimelineEventDetails'

// A command whose prompt came back before it finished keeps printing. The
// operator opens the command, not a pile of rows beside it, so the detail has
// to say the output is still arriving and then show all of it.

const install = (rows: unknown[]): void => {
  window.localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { commandOutput: vi.fn(async () => ({ items: rows, hasMore: false })), onNewBatch: vi.fn(() => () => {}) }
  }
}
afterEach(() => { cleanup(); window.localStorage.clear() })

describe('CommandEndDetail background output', () => {
  const data = { command: 'sleep 1; echo hi &', command_id: 'c1', late_output: true, exit_code: 0 }

  it('shows a running state until the final row arrives', async () => {
    install([{ id: 'a', data: { seq: 1, late: true, stdout: 'hi\n' } }])
    render(<I18nProvider><CommandEndDetail projectId="project" eventId="command" data={data} /></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('late-output').textContent).toContain('hi'))
    expect(screen.getByTestId('late-output').textContent).toMatch(/no output completion record|尚無輸出完成紀錄/)
  })

  it('says finished, and what was not kept', async () => {
    install([
      { id: 'a', data: { seq: 1, late: true, stdout: 'hi\n' } },
      { id: 'f', data: { seq: 2, late: true, final: true, late_bytes: 3, dropped_bytes: 100 } }
    ])
    render(<I18nProvider><CommandEndDetail projectId="project" eventId="command" data={data} /></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('late-output').textContent).toMatch(/incomplete|不完整/))
    expect(screen.getByTestId('late-output').textContent).toMatch(/not kept|未保留/)
  })

  it('labels a bounded preview without pretending its missing final row means still running', async () => {
    install([])
    vi.mocked(window.redlog.events.commandOutput).mockResolvedValue({ items: [], hasMore: true })
    render(<I18nProvider><CommandEndDetail projectId="project" eventId="command" data={data} /></I18nProvider>)
    await screen.findByText(/Preview limited/)
    expect(screen.queryByText(/no output completion record/)).toBeNull()
  })

  it('keeps previously read output when refreshing fails and allows retry', async () => {
    install([{ id: 'a', data: { seq: 1, late: true, stdout: 'saved output\n' } }])
    render(<I18nProvider><CommandEndDetail projectId="project" eventId="command" data={data} /></I18nProvider>)
    await screen.findByText('saved output')
    const refresh = vi.mocked(window.redlog.events.onNewBatch).mock.calls[0][0]
    vi.mocked(window.redlog.events.commandOutput).mockRejectedValueOnce(new Error('read failed'))
    await act(async () => { refresh([]) })
    await screen.findByRole('alert')
    expect(screen.getByTestId('late-output').textContent).toContain('saved output')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('does not ask for background output of an ordinary command', () => {
    install([])
    render(<I18nProvider><CommandEndDetail projectId="project" eventId="command" data={{ command: 'ls', command_id: 'c2', exit_code: 0 }} /></I18nProvider>)
    expect(screen.queryByTestId('late-output')).toBeNull()
  })
})
