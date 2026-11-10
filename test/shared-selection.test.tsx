// @vitest-environment jsdom
//
// Spec 069 FR-006: the list, the Timeline and the Reader read one selected
// event. The Timeline already keeps its selection under a storage key; the
// Activity list used to keep its own, so choosing a source there and switching
// to the Timeline landed on something else.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActivityResults } from '../src/renderer/src/components/ActivityResults'
import { SELECTED_EVENT_KEY } from '../src/renderer/src/lib/selectedEvent'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock('../src/renderer/src/components/CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button>{text}</button> }))

const start = { id: 'start', timestamp: 1, agentType: 'shell', data: { command: 'id', subtype: 'command_start' } }
const end = { ...start, id: 'end', timestamp: 2, data: { command: 'id', subtype: 'command_end', exit_code: 0 } }

function mount(): void {
  const item = { id: 'activity', kind: 'command', toolAction: 'unknown', provider: null, firstAt: 1, anchor: start, matchedCount: 2, contextCount: 0 }
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: {
      onNewBatch: () => () => {},
      activityPage: vi.fn().mockResolvedValue({ items: [item], hasMore: false, totalGroups: 1, totalMatches: 2, snapshot: {} }),
      activityMembers: vi.fn().mockResolvedValue({ items: [{ event: start, matched: true }, { event: end, matched: true }], hasMore: false, nextCursor: null, sourceCount: 2, matchedCount: 2, snapshot: {} })
    },
    content: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      read: vi.fn()
    }
  }
  render(<ActivityResults request={{ parsed: { text: 'id', conditions: [], tokens: [] } } as any} />)
}

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); localStorage.clear() })

// The sources of an operation are read in the Reader (Spec 069 T019): choose the
// row, open it, then the source events are tabs.
const openReader = async (): Promise<void> => {
  fireEvent.click(await screen.findByTestId('activity-row'))
  fireEvent.click(await screen.findByTestId('activity-read'))
  await screen.findAllByTestId('reader-source-tab')
}
const tabs = (): HTMLElement[] => screen.getAllByTestId('reader-source-tab')
const selectedTab = (): string | null => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.getAttribute('data-event-id') ?? null

it('publishes the source the operator picks, so the Timeline opens on it', async () => {
  mount()
  await openReader()
  fireEvent.click(tabs().find((tab) => tab.getAttribute('data-event-id') === 'end')!)
  await waitFor(() => expect(localStorage.getItem(SELECTED_EVENT_KEY)).toBe('end'))
})

it('opens on the event already selected elsewhere when it is one of the sources', async () => {
  localStorage.setItem(SELECTED_EVENT_KEY, 'end')
  mount()
  await openReader()
  expect(selectedTab()).toBe('end')
})

it('ignores a stored selection that is not one of this activity\'s sources', async () => {
  localStorage.setItem(SELECTED_EVENT_KEY, 'unrelated')
  mount()
  await openReader()
  expect(['start', 'end']).toContain(selectedTab())
})
