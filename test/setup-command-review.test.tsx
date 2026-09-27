// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SetupCommandReview } from '../src/renderer/src/components/SetupCommandReview'
import { I18nProvider } from '../src/renderer/src/i18n'
import { requestRunInTerminal, takePendingCommand } from '../src/renderer/src/lib/terminalRunner'

afterEach(() => { cleanup(); takePendingCommand() })
it('shows setup as a copyable draft without typing into a running terminal', async () => {
  const write = vi.fn()
  Object.assign(window, { redlog: { terminal: { write } } })
  render(<I18nProvider><SetupCommandReview /></I18nProvider>)
  act(() => requestRunInTerminal('echo setup-review'))
  expect(await screen.findByText('echo setup-review')).not.toBeNull()
  expect(write).not.toHaveBeenCalled()
  expect(takePendingCommand()).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
  expect(screen.queryByText('echo setup-review')).toBeNull()
})
