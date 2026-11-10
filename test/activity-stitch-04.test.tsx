// @vitest-environment jsdom
//
// Stitch 04: the source as a badge with the result inline, the new-events
// banner says how many arrived, and the Reader's hash section says what it is
// (a stored snapshot) and what it is not (a verification).

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActivityResults } from '../src/renderer/src/components/ActivityResults'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, unknown>) => v ? `${k} ${JSON.stringify(v)}` : k }) }))
vi.mock('../src/renderer/src/components/CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button>{text}</button> }))

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id, timestamp: 1000, agentType: 'shell', sessionId: `sess-${id}`, targetId: null, hash: `hash-${id}`, prevHash: `prev-${id}`,
  data: { command: id, subtype: 'command_end', exit_code: 2 }, ...over
})
const summary = (id: string) => ({
  id, kind: 'command', toolAction: 'unknown', provider: null, firstAt: 1000, anchor: ev(id), matchedCount: 1, sourceCount: 1, contextCount: 0, result: { exitCode: 2 }
})

let push: (events: unknown[]) => void = () => {}
const api = { activityPage: vi.fn(), activityMembers: vi.fn() }
function mount(): void {
  api.activityPage.mockResolvedValue({ items: [summary('a')], hasMore: false, nextCursor: null, totalGroups: 1, totalMatches: 1, snapshot: {} })
  api.activityMembers.mockResolvedValue({ items: [{ event: ev('a'), matched: true }], hasMore: false, nextCursor: null, sourceCount: 1, matchedCount: 1, snapshot: {} })
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { onNewBatch: (cb: (e: unknown[]) => void) => { push = cb; return () => {} }, ...api },
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), read: vi.fn() }
  }
  render(<ActivityResults request={{ parsed: { text: '', conditions: [], tokens: [] } } as any} />)
}

beforeEach(() => { localStorage.clear(); Object.values(api).forEach((f) => f.mockReset()) })
afterEach(() => cleanup())

it('draws the source as a badge, tinted when the command failed, with the result on the same line', async () => {
  mount()
  const badge = await screen.findByTestId('activity-source-badge')
  expect(badge.className).toMatch(/text-red-300/)
  const row = screen.getByTestId('activity-row')
  expect(row.textContent).toContain('activity.result.failed')
  expect(row.textContent).not.toContain('activity.kind.command')
  expect(badge.getAttribute('title')).toContain('activity.kind.command')
})

it('counts the events that arrived since the page was read, and a refresh clears the count', async () => {
  mount()
  await screen.findByTestId('activity-row')
  act(() => { push([ev('x'), ev('y')]) })
  act(() => { push([ev('z')]) })
  const banner = screen.getByTestId('activity-new-events')
  expect(banner.textContent).toContain('"count":3')
  fireEvent.click(banner)
  expect(screen.queryByTestId('activity-new-events')).toBeNull()
})

it('says the hash section is a stored snapshot, not a verification', async () => {
  mount()
  fireEvent.click(await screen.findByTestId('activity-row'))
  fireEvent.click(await screen.findByTestId('activity-read'))
  const integrity = await screen.findByTestId('reader-integrity')
  expect(integrity.textContent).toContain('activity.reader.integrity')
  expect(integrity.textContent).toContain('activity.reader.integrityNote')
  expect(integrity.textContent).toContain('hash-a')
  expect(integrity.textContent).toContain('a')
})
