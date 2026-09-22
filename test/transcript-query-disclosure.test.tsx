// @vitest-environment jsdom
//
// Spec 017 T013 and T017. What the Transcript must say about a query, beyond
// its rows. Each of these exists because the alternative is an empty screen
// that an operator would read as absence:
//
//   a mistyped field silently demoted to a search term
//   a half-typed condition that was never asked
//   a tool-use id narrowed to one of several sessions
//   a term that cannot reach output living in a terminal recording

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({
    filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
  }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

const empty = { items: [], hasMore: false, nextCursor: null }

function installBridge(runQueryImpl?: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  const runQuery = runQueryImpl ?? vi.fn().mockResolvedValue(empty)
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage: vi.fn().mockResolvedValue(empty),
      runQuery,
      toolCounterparts: vi.fn().mockResolvedValue([]),
      onNewBatch: () => () => {}
    },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn().mockResolvedValue(true), readText: vi.fn().mockResolvedValue('') }
  }
  return runQuery
}

async function renderView(): Promise<void> {
  const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
  render(<TranscriptView />)
  await waitFor(() => expect(screen.getByRole('textbox')).not.toBeNull())
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the Transcript shows how it read the query (T013)', () => {
  it('distinguishes a condition from a term', async () => {
    installBridge()
    await renderView()

    type('session:S1 timeout')

    const strip = await screen.findByTestId('transcript-query-parse', {}, { timeout: 3000 })
    expect(strip.textContent).toContain('session:S1')
    expect(strip.textContent).toContain('timeout')
  })

  it('shows a mistyped field as text, so the typo is visible', async () => {
    installBridge()
    await renderView()

    type('sesion:S1')

    const strip = await screen.findByTestId('transcript-query-parse', {}, { timeout: 3000 })
    const token = Array.from(strip.querySelectorAll('span')).find((el) => el.textContent === 'sesion:S1')
    expect(token).toBeDefined()
    expect(token!.getAttribute('title')).toBe('transcript.queryTokenText')
  })

  it('shows nothing when there is no query', async () => {
    installBridge()
    await renderView()
    expect(screen.queryByTestId('transcript-query-parse')).toBeNull()
  })
})

describe('the Transcript separates unparsable from empty (T017)', () => {
  it('explains a half-typed condition instead of showing no results', async () => {
    const runQuery = installBridge()
    await renderView()

    type('session:')

    const notice = await screen.findByTestId('transcript-query-unparsable', {}, { timeout: 3000 })
    expect(notice.textContent).toContain('transcript.queryUnparsable')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('clears the explanation once the condition is complete', async () => {
    installBridge()
    await renderView()

    type('session:')
    await screen.findByTestId('transcript-query-unparsable', {}, { timeout: 3000 })

    type('session:S1')
    await waitFor(
      () => expect(screen.queryByTestId('transcript-query-unparsable')).toBeNull(),
      { timeout: 3000 }
    )
  })
})

describe('the Transcript discloses what it narrowed and what it cannot reach', () => {
  it('names the session a bare tool-use condition resolved within', async () => {
    installBridge(vi.fn().mockResolvedValue({
      ...empty,
      toolSession: { toolUseId: 'T7', sessionId: 'S1', otherSessionIds: ['S2', 'S3'] }
    }))
    await renderView()

    type('tool:T7')

    const notice = await screen.findByTestId('transcript-tool-session', {}, { timeout: 3000 })
    expect(notice.textContent).toContain('transcript.queryToolSession')
    expect(notice.textContent).toContain('transcript.queryToolSessionOthers')
  })

  it('states the coverage limit while a term is being matched', async () => {
    installBridge()
    await renderView()

    type('timeout')
    expect(await screen.findByTestId('transcript-query-coverage', {}, { timeout: 3000 })).not.toBeNull()
  })

  it('does not state it for a conditions-only query, which matches no text', async () => {
    installBridge()
    await renderView()

    type('session:S1')
    await screen.findByTestId('transcript-query-parse', {}, { timeout: 3000 })
    expect(screen.queryByTestId('transcript-query-coverage')).toBeNull()
  })
})
