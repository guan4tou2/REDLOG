// @vitest-environment jsdom
//
// Spec 074 T015 (US2): a surface that reads for one event must not show the
// answer for another while its own is on the way. The Timeline Inspector
// renders `CommandEndDetail` for the selected command
// (`timeline/TimelineEventInspector.tsx`, no key), so choosing command B
// re-renders the same instance with B's props, and what it holds is A's.
//
// Two readers inside it keep what they have while they read again:
//   - `EventContentReader` lists the event's fields through `useReadState`,
//     whose value "survives" a refresh by design; the field list is A's until
//     B's arrives, and each field reader is keyed by B's id with A's
//     descriptor, so it opens A's saved bytes under B.
//   - `LateOutput` does the same with `commands output`.
// The correct behaviour (Phase 6, `useQuery` with an identity in its key, and
// `readState` that names what its value belongs to): B's header shows, A's
// fields do not, until B's own come back. Both are `it.fails`; the pins above
// them show the fixture works (A's content is there when A is selected, B's
// when B's has arrived).
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CommandEndDetail } from '../src/renderer/src/components/TimelineEventDetails'

type Resolver<T> = (value: T) => void
let listA!: Resolver<unknown>, listB!: Resolver<unknown>, lateA!: Resolver<unknown>, lateB!: Resolver<unknown>

const field = (eventId: string): Record<string, unknown> => ({
  field: 'stdout', status: 'available', bytes: 12, format: 'utf8', capture: 'unknown',
  ref: { projectId: 'p', eventId, field: 'stdout', version: `v-${eventId}` }
})
const lateRows = (id: string): unknown => ({
  items: [{ id: `late-${id}`, timestamp: 1, agentType: 'shell', data: { subtype: 'command_output', command_id: id, stdout: `LATE-${id}`, final: true, late_bytes: 9 } }],
  hasMore: false
})

function install(deferB: boolean): void {
  const content = {
    list: vi.fn(({ eventId }: { eventId: string }) => (deferB && eventId === 'B'
      ? new Promise((resolve) => { listB = resolve })
      : eventId === 'A' ? new Promise((resolve) => { listA = resolve }) : Promise.resolve({ ok: true, value: [field(eventId)] }))),
    read: vi.fn(async ({ ref }: { ref: { eventId: string } }) => ({
      ok: true, value: { offset: 0, end: 12, total: 12, text: `SAVED-${ref.eventId}`, format: 'utf8', hasMore: false, nextCursor: null }
    })),
    find: vi.fn()
  }
  const events = {
    commandOutput: vi.fn((id: string) => (deferB && id === 'cB'
      ? new Promise((resolve) => { lateB = resolve })
      : id === 'cA' ? new Promise((resolve) => { lateA = resolve }) : Promise.resolve(lateRows(id)))),
    onNewBatch: () => () => {}
  }
  ;(window as unknown as { redlog: unknown }).redlog = { content, events }
}

const data = (id: string): Record<string, unknown> => ({
  subtype: 'command_end', command: 'id', command_id: `c${id}`, exit_code: 0, late_output: true,
  stdout_ref: { sha256: 'a'.repeat(64), size: 12, file: `${id}.body`, encoding: 'text' }
})
const reader = { mode: 'inline' as const, setMode: () => {} }
const tree = (id: string): JSX.Element =>
  <I18nProvider><CommandEndDetail projectId="p" eventId={id} data={data(id)} reader={reader} /></I18nProvider>

beforeEach(() => { window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => cleanup())

async function showA(): Promise<ReturnType<typeof render>> {
  const view = render(tree('A'))
  await waitFor(() => expect(listA).toBeDefined())
  await act(async () => { listA({ ok: true, value: [field('A')] }); lateA(lateRows('cA')) })
  await screen.findByText('SAVED-A', { selector: 'pre' })
  await screen.findByText('LATE-cA')
  return view
}

it('(pin) shows the saved bytes and the late output of the selected command', async () => {
  install(true)
  await showA()
})

it('(pin) shows B\'s own content once B\'s reads have come back', async () => {
  install(true)
  const view = await showA()
  view.rerender(tree('B'))
  await act(async () => { listB({ ok: true, value: [field('B')] }); lateB(lateRows('cB')) })
  await screen.findByText('SAVED-B', { selector: 'pre' })
  await screen.findByText('LATE-cB')
  expect(screen.queryByText('SAVED-A')).toBeNull()
  expect(screen.queryByText('LATE-cA')).toBeNull()
})

it.fails('does not show command A\'s saved bytes while command B\'s are being read', async () => {
  install(true)
  const view = await showA()
  view.rerender(tree('B'))
  await act(async () => { await Promise.resolve() })
  expect(screen.queryByText('SAVED-A', { selector: 'pre' }), "A's saved bytes under B").toBeNull()
})

it.fails('does not show command A\'s late output while command B\'s is being read', async () => {
  install(true)
  const view = await showA()
  view.rerender(tree('B'))
  await act(async () => { await Promise.resolve() })
  expect(screen.queryByText('LATE-cA'), "A's late output under B").toBeNull()
})
