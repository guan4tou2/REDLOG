// @vitest-environment jsdom
//
// #460, the app's side. The addon now writes a capture_gap when its send
// queue refuses an event. Three things stood between that record and the
// operator: a gap the addon could not write left a log line no screen read;
// the Timeline titled the gap "[capture_gap]", with no count and no cause; and
// a gap counted while recording was paused read, once replayed, as a loss in
// a stretch nothing was meant to be recorded.

import { EventEmitter } from 'node:events'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ManagedHttpProxy, type ManagedProxyStatus } from '../src/main/services/managed-http-proxy'
import { eventTitle } from '../src/renderer/src/lib/eventTitle'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { pauseIntervals, queueGapAgainstPauses } from '../src/core/queue-gap'
import type { RedLogEvent } from '../src/core/db/events'

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(): boolean { this.killed = true; this.exitCode = 0; this.emit('exit', 0, null); return true }
}

afterEach(() => { cleanup(); localStorage.clear() })

describe('a gap the addon could not write', () => {
  it('is counted from the proxy output, even split across chunks, and kept after a restart', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({ spawn: vi.fn(() => child as never), exists: () => true, fingerprint: () => null,
      readinessTimeoutMs: 100, probe: async () => true })
    const seen: Array<[number | undefined, number | undefined]> = []
    proxy.onStatusChange((next: ManagedProxyStatus, previous: ManagedProxyStatus) => seen.push([next.unsavedGapEvents, previous.unsavedGapEvents]))
    await proxy.start({ addonPath: '/addon.py', port: 6661 })
    expect(proxy.status().unsavedGapEvents).toBeUndefined()
    child.stdout.emit('data', Buffer.from('[10:00:00.000] [redlog] capture gap not sa'))
    child.stdout.emit('data', Buffer.from('ved: 3 event(s) refused at a full send queue are not recorded anywhere\n[10:00:01.000] [redlog] capture gap not saved: 2 event(s) refused\n'))
    expect(proxy.status().unsavedGapEvents).toBe(5)
    expect(seen.filter(([n]) => n !== undefined).at(-1)).toEqual([5, 3])
    proxy.stop()
    expect(proxy.status().unsavedGapEvents).toBe(5)
  })

  // The app puts an unsaved gap in the project open now. A project-switched
  // gap belongs to the project that was closed, so its line is not counted.
  it('does not count an unsaved project-switched gap against the open project', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({ spawn: vi.fn(() => child as never), exists: () => true, fingerprint: () => null,
      readinessTimeoutMs: 100, probe: async () => true })
    await proxy.start({ addonPath: '/addon.py', port: 6661 })
    child.stdout.emit('data', Buffer.from('[10:00:00.000] [redlog] project-switch gap not saved: 2 event(s) for a closed project are not recorded anywhere\n'))
    expect(proxy.status().unsavedGapEvents).toBeUndefined()
    proxy.stop()
  })

  it('is on the Capture Health card while it is there', () => {
    localStorage.setItem('redlog-locale', 'en')
    ;(window as unknown as { redlog: unknown }).redlog = { config: { get: async () => ({}), save: async () => true } }
    const capture = { verdict: 'partial', recording: true, lastEventAt: null, checkedAt: 1,
      sources: [{ id: 'mitmproxy', hookId: 'mitmproxy', installed: true, state: 'ready', lastEventAt: null }],
      managedHttpProxy: { state: 'running', url: 'http://127.0.0.1:6661', unsavedGapEvents: 7 } }
    const { container } = render(<I18nProvider>{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} /></I18nProvider>)
    expect(container.querySelector('[data-testid="capture-http-gap-unsaved"]')?.textContent).toMatch(/7/)
  })
})

const ev = (agentType: string, data: Record<string, unknown>): RedLogEvent => ({
  id: 'g', timestamp: 1, engagementId: 'e', sessionId: 's', operatorId: 'o', agentType, hostname: 'h',
  sourceIP: null, targetId: null, data, createdAt: 1
})

describe('a capture gap on the Timeline', () => {
  it('says how many events the proxy queue refused', () => {
    const title = eventTitle(ev('scanner', { subtype: 'capture_gap', source: 'mitmproxy', reason: 'queue-full', skipped_units: 12 }))
    expect(title).toMatch(/12/)
    expect(title).not.toMatch(/\[capture_gap\]/)
  })

  it('names an unconfirmed delivery as one, without a count it does not have', () => {
    const title = eventTitle(ev('scanner', { subtype: 'capture_gap', source: 'mitmproxy', reason: 'delivery-unconfirmed' }))
    expect(title).not.toMatch(/\[capture_gap\]|undefined/)
  })

  it('says how many events arrived after their project was closed', () => {
    const title = eventTitle(ev('scanner', { subtype: 'capture_gap', source: 'mitmproxy', reason: 'project-switched', skipped_units: 3 }))
    expect(title).toMatch(/3/)
    expect(title).not.toMatch(/\[capture_gap\]/)
  })

  it('names refusals that could not be recorded even as a gap', () => {
    const title = eventTitle(ev('system', { subtype: 'capture_gap', source: 'managed-http-proxy', reason: 'gap-unsaved', skipped_units: 4 }))
    expect(title).toMatch(/4/)
    expect(title).not.toMatch(/system: capture_gap/)
  })
})

describe('a queue-full gap replayed after a pause', () => {
  const rows = [
    { subtype: 'recording_paused', timestamp: 1000 },
    { subtype: 'recording_resumed', timestamp: 2000 },
    { subtype: 'recording_paused', timestamp: 5000 }
  ]
  const gap = (from: number, to: number): Record<string, unknown> =>
    ({ subtype: 'capture_gap', reason: 'queue-full', gap_started_at: from, gap_ended_at: to, skipped_units: 3 })

  it('reads pauses as intervals, an unresumed one still open', () => {
    expect(pauseIntervals(rows)).toEqual([[1000, 2000], [5000, Infinity]])
  })

  it('is dropped when every refusal fell while recording was paused', () => {
    expect(queueGapAgainstPauses(gap(1200, 1800), pauseIntervals(rows))).toBeNull()
    expect(queueGapAgainstPauses(gap(6000, 7000), pauseIntervals(rows))).toBeNull()
  })

  it('is kept, and says so, when its window crosses a pause boundary', () => {
    expect(queueGapAgainstPauses(gap(1500, 2500), pauseIntervals(rows))).toMatchObject({ skipped_units: 3, overlaps_pause: true })
  })

  it('is kept unchanged outside any pause, and other gaps are not judged', () => {
    expect(queueGapAgainstPauses(gap(3000, 4000), pauseIntervals(rows))).toEqual(gap(3000, 4000))
    const other = { subtype: 'capture_gap', reason: 'delivery-unconfirmed', reported_at: 1500 }
    expect(queueGapAgainstPauses(other, pauseIntervals(rows))).toEqual(other)
  })
})
