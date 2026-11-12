// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { CommandEndDetail, AgentTurnDetail } from '../src/renderer/src/components/TimelineEventDetails'
import { HttpDetail } from '../src/renderer/src/components/HttpDetail'
import { ActivityReader } from '../src/renderer/src/components/ActivityReader'
import { contentState, type ContentDescriptor, type ContentField, type ContentState } from '../src/core/content-contract'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

const cases: Array<[ContentState, Partial<ContentDescriptor>, string | null]> = [
  ['available', {}, null],
  ['empty', { bytes: 0 }, 'content.empty'],
  ['not-captured', { status: 'not-captured', ref: null }, 'content.status.not-captured'],
  ['unreadable', { status: 'missing', ref: null }, 'content.status.missing'],
  ['truncated', { capture: 'partial', bytes: 0 }, 'content.partial']
]

function mount(kind: 'shell' | 'http' | 'ai' | 'ai-timeline', descriptor: ContentDescriptor): void {
  const field: ContentField = kind === 'shell' ? 'stdout' : kind === 'http' ? 'response_body' : 'full'
  descriptor = { ...descriptor, field, ref: descriptor.ref && { ...descriptor.ref, field } }
  const event = { id: 'e', timestamp: 1, engagementId: 'p', sessionId: 's', operatorId: 'op', targetId: null,
    agentType: kind === 'http' ? 'scanner' : kind.startsWith('ai') ? 'agent' : 'shell', data: { subtype: kind.startsWith('ai') ? 'assistant_message' : 'command_end' } }
  ;(window as any).redlog = {
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [descriptor] }),
      read: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0, end: descriptor.bytes, total: descriptor.bytes,
        text: descriptor.bytes ? 'saved' : '', format: 'utf8', hasMore: false, nextCursor: null } }) },
    events: { activityMembers: vi.fn().mockResolvedValue({ items: [{ event, matched: true }], hasMore: false, sourceCount: 1, matchedCount: 1 }) }
  }
  const reader = { mode: 'inline' as const, setMode: vi.fn() }
  // A confirmed empty run: zero saved bytes alone no longer reads as "nothing
  // produced" for a command (report 10, A.4 #1).
  if (kind === 'shell') render(<CommandEndDetail projectId="p" eventId="e" data={{ subtype: 'command_end', stdout: '', completeness: 'complete', output_disposition: 'captured' }} reader={reader} />)
  else if (kind === 'http') render(<HttpDetail projectId="p" eventId="e" data={{ subtype: 'http_response' }} reader={reader} />)
  else if (kind === 'ai-timeline') render(<AgentTurnDetail projectId="p" eventId="e" data={{ subtype: 'assistant_message' }} reader={reader} />)
  else render(<ActivityReader items={[{ id: 'e', kind: 'message', provider: 'test-provider', firstAt: 1, anchor: event,
    matchedCount: 1, sourceCount: 1, contextCount: 0 } as any]} index={0} request={{ projectId: 'p' } as any}
    snapshot={{} as any} active filtering={false} hasMore={false} loading={false} onStep={vi.fn()} onClose={vi.fn()} />)
}

describe('one saved-content contract across Shell, HTTP and AI Readers (#591)', () => {
  it.each(cases)('%s has the same conclusion in every Reader', async (state, overrides, message) => {
    const descriptor: ContentDescriptor = { field: 'stdout', status: 'available', bytes: 5, format: 'utf8', capture: 'unknown',
      ref: { projectId: 'p', eventId: 'e', field: 'stdout', version: 'v' }, ...overrides }
    expect(contentState(descriptor)).toBe(state)
    for (const kind of ['shell', 'http', 'ai', 'ai-timeline'] as const) {
      mount(kind, descriptor)
      await waitFor(() => expect(document.querySelector(`[data-content-state="${state}"]`)).toBeTruthy())
      if (message) expect(await screen.findByText(message)).toBeTruthy()
      if (state === 'available') expect(await screen.findByText('saved', { selector: 'pre' })).toBeTruthy()
      cleanup()
    }
  })
})

it('hides empty or uncaptured stderr but preserves a saved stderr failure', async () => {
  const { EventContentReader } = await import('../src/renderer/src/components/EventContentReader')
  for (const status of ['available', 'not-captured', 'missing'] as const) {
    const stdout: ContentDescriptor = { field: 'stdout', status: 'available', bytes: 5, format: 'utf8', capture: 'unknown', ref: { projectId: 'p', eventId: 'e', field: 'stdout', version: 'v' } }
    ;(window as any).redlog = { content: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [stdout, { ...stdout, field: 'stderr', bytes: 0, status, ref: null }] }),
      read: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0, end: 5, total: 5, text: 'saved', hasMore: false } })
    } }
    render(<EventContentReader projectId="p" eventId="e" />)
    await screen.findByRole('combobox')
    expect(screen.queryByRole('option', { name: 'content.field.stderr' }) !== null).toBe(status === 'missing')
    cleanup()
  }
})
