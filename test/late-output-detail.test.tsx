// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CommandEndDetail } from '../src/renderer/src/components/TimelineEventDetails'

// A command whose prompt came back before it finished keeps printing. The
// operator opens the command, not a pile of rows beside it, so the detail has
// to say the output is still arriving and then show all of it.

const install = (rows: unknown[]): void => {
  window.localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { commandOutput: vi.fn(async () => rows), onNewBatch: vi.fn(() => () => {}) }
  }
}
afterEach(() => { cleanup(); window.localStorage.clear() })

describe('CommandEndDetail background output', () => {
  const data = { command: 'sleep 1; echo hi &', command_id: 'c1', late_output: true, exit_code: 0 }

  it('shows a running state until the final row arrives', async () => {
    install([{ id: 'a', data: { seq: 1, late: true, stdout: 'hi\n' } }])
    render(<I18nProvider><CommandEndDetail data={data} /></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('late-output').textContent).toContain('hi'))
    expect(screen.getByTestId('late-output').textContent).toMatch(/still running|仍在執行/)
  })

  it('says finished, and what was not kept', async () => {
    install([
      { id: 'a', data: { seq: 1, late: true, stdout: 'hi\n' } },
      { id: 'f', data: { seq: 2, late: true, final: true, late_bytes: 3, dropped_bytes: 100 } }
    ])
    render(<I18nProvider><CommandEndDetail data={data} /></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('late-output').textContent).toMatch(/incomplete|不完整/))
    expect(screen.getByTestId('late-output').textContent).toMatch(/not kept|未保留/)
  })

  it('does not ask for background output of an ordinary command', () => {
    install([])
    render(<I18nProvider><CommandEndDetail data={{ command: 'ls', command_id: 'c2', exit_code: 0 }} /></I18nProvider>)
    expect(screen.queryByTestId('late-output')).toBeNull()
  })
})
