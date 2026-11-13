// @vitest-environment jsdom
//
// Spec 069 FR-007: an event whose source has no reader of its own still shows
// what it recorded, without throwing and without interpreting the values.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { GenericEventDetail } from '../src/renderer/src/components/TimelineEventDetails'
import { eventReader } from '../src/renderer/src/lib/timelineEvents'

afterEach(() => { cleanup(); localStorage.clear() })
const draw = (data: Record<string, unknown>): void => {
  localStorage.setItem('redlog-locale', 'en')
  render(<I18nProvider><GenericEventDetail data={data} /></I18nProvider>)
}

describe('GenericEventDetail', () => {
  it('lists the recorded scalar fields and summarises nested ones', () => {
    draw({ host: '10.0.0.5', port: 443, ok: true, nested: { a: 1, b: 2 }, list: [1, 2, 3] })
    expect(screen.getByText('host')).toBeTruthy()
    expect(screen.getByText('10.0.0.5')).toBeTruthy()
    expect(screen.getByText('443')).toBeTruthy()
    expect(screen.getByText('true')).toBeTruthy()
    expect(screen.getByText('{2}')).toBeTruthy()
    expect(screen.getByText('[3]')).toBeTruthy()
  })

  // Spec 071 review F: the receiver's stamp is not a recorded field of the
  // source; showing provenance belongs to Spec 072's readers.
  it('does not list `_ingest`, and a row with nothing but it shows no fields', () => {
    draw({ host: '10.0.0.6', _ingest: { v: 1, door: 'legacy-api', producer: 'legacy', credential: null, auth: 'bearer', event_id: 'x' } })
    expect(screen.getByText('host')).toBeTruthy()
    expect(screen.queryByText('_ingest')).toBeNull()
    expect(screen.queryByText('{6}')).toBeNull()
    cleanup()
    draw({ _ingest: { v: 1 } })
    expect(document.querySelector('[data-testid="generic-event-detail"]')).toBeNull()
  })

  it('shows markup as text, never as elements', () => {
    draw({ note: '<img src=x onerror=alert(1)>' })
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('cuts a very long value instead of flooding the pane', () => {
    draw({ blob: 'x'.repeat(5000) })
    const cell = screen.getByText(/^x+…$/)
    expect(cell.textContent!.length).toBeLessThan(700)
  })

  it('renders nothing for an event with no data, and does not throw', () => {
    const { container } = render(<I18nProvider><GenericEventDetail data={{}} /></I18nProvider>)
    expect(container.textContent).toBe('')
    expect(() => render(<I18nProvider><GenericEventDetail data={undefined as never} /></I18nProvider>)).not.toThrow()
  })
})

describe('eventReader', () => {
  const ev = (agentType: string, subtype?: string) => ({ agentType, data: { subtype } }) as never
  // By kind, not by source (report 10, A.4 #8): test/event-reader-by-kind.test.tsx
  // holds the full table.
  it('knows the kinds that have their own detail', () => {
    for (const [t, s] of [['shell', 'command_end'], ['agent', 'tool_call'], ['scanner', 'http_response'], ['browser', 'console_error'], ['marker', undefined], ['screenshot', undefined]] as const)
      expect(eventReader(ev(t, s))).not.toBe('generic')
    expect(eventReader(ev('file_transfer', 'artifact_added'))).toBe('artifact')
  })
  it('sends everything else to the generic reader', () => {
    expect(eventReader(ev('some-plugin-source'))).toBe('generic')
    expect(eventReader(ev('file_transfer', 'download_seen'))).toBe('generic')
    expect(eventReader(ev('scanner', 'packet_flow'))).toBe('generic')
    expect(eventReader(ev('shell', 'capture_stopped'))).toBe('generic')
  })
})
