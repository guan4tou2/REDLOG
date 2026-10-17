// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { eventTitle } from '../src/renderer/src/lib/eventTitle'
import { artifactToast } from '../src/renderer/src/lib/addArtifacts'
import { EvidenceFileDetail } from '../src/renderer/src/components/TimelineEventDetails'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'

const toasts = vi.hoisted(() => [] as Array<{ message: string; opts: unknown }>)
vi.mock('../src/renderer/src/components/Toast', () => ({
  toast: (message: string, opts: unknown) => { toasts.push({ message, opts }) }
}))

const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

const event = (data: Record<string, unknown>): RedLogEvent => ({
  id: 'e1', timestamp: 1, agentType: 'file_transfer', data, engagementId: 'eng', operatorId: 'op', targetId: null
} as unknown as RedLogEvent)

const ARTIFACT = {
  subtype: 'artifact_added', source: 'operator', path: '/Users/me/Downloads/report.xml',
  stored: 'artifacts/0123456789ab-report.xml', sha256: 'abcdef0123456789'.repeat(4), size: 1_258_291, mtime: 1_700_000_000_000
}

describe('a file the operator added reads as evidence they can find', () => {
  it('is titled by name, size and the start of its hash — not as a bare transfer', () => {
    const title = eventTitle(event(ARTIFACT))
    expect(title).toContain('Evidence file: report.xml')
    expect(title).toContain('1.2 MB')
    expect(title).toContain('sha256 abcdef01')
    expect(title).not.toMatch(/undefined|artifact_added/)
  })

  it('says when the same bytes were already stored', () => {
    expect(eventTitle(event({ ...ARTIFACT, duplicate: true }))).toContain('already stored')
  })

  it('leaves a transfer RedLog detected itself titled as before', () => {
    expect(eventTitle(event({ direction: 'upload', path: '/tmp/x.bin', size: 10 }))).toBe('upload: /tmp/x.bin (10B)')
  })
})

describe('the toast after adding a file', () => {
  const outcome = (over: Record<string, unknown> = {}): ArtifactAddOutcome => ({
    ok: true, originalPath: '/Users/me/Downloads/report.xml', stored: 'artifacts/x-report.xml', sha256: 'aa', bytes: 1, mtime: 1,
    duplicate: false, eventId: 'ev-77', relatedCommands: 0, ...over
  }) as ArtifactAddOutcome

  it('offers "Show", which opens the timeline on the row that was just recorded', () => {
    const show = vi.fn()
    const toastData = artifactToast(outcome(), t, show)
    expect(toastData.action?.label).toBe('Show')
    toastData.action!.onClick()
    expect(show).toHaveBeenCalledWith('ev-77', expect.any(Number))
  })

  it('offers it on a duplicate too, since that adds a row as well', () => {
    expect(artifactToast(outcome({ duplicate: true }), t, vi.fn()).action?.label).toBe('Show')
  })

  it('offers nothing when the file was not recorded, or when there is nowhere to go', () => {
    expect(artifactToast(outcome({ eventId: null }), t, vi.fn()).action).toBeUndefined()
    expect(artifactToast(outcome(), t).action).toBeUndefined()
    expect(artifactToast({ ok: false, originalPath: '/x', error: 'unreadable' } as ArtifactAddOutcome, t, vi.fn()).action).toBeUndefined()
  })
})

describe('the evidence file detail', () => {
  const reveal = vi.fn()
  beforeEach(() => {
    toasts.length = 0
    reveal.mockReset()
    localStorage.setItem('redlog-locale', 'en')
    ;(window as unknown as { redlog: unknown }).redlog = { artifacts: { reveal } }
  })
  afterEach(() => cleanup())

  const draw = (data: Record<string, unknown>): void => {
    render(<I18nProvider><EvidenceFileDetail data={data} /></I18nProvider>)
  }

  it('shows the hash and where RedLog keeps its copy', () => {
    draw(ARTIFACT)
    const text = screen.getByTestId('evidence-file-detail').textContent ?? ''
    expect(text).toContain(ARTIFACT.sha256)
    expect(text).toContain('artifacts/0123456789ab-report.xml')
    expect(text).toContain('report.xml')
  })

  it('reveals the stored copy — by its recorded path, as an artifact — and never opens it', async () => {
    reveal.mockResolvedValue(true)
    draw(ARTIFACT)
    fireEvent.click(screen.getByTestId('evidence-file-reveal'))
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('artifact', 'artifacts/0123456789ab-report.xml'))
    expect(toasts).toEqual([])
    expect(Object.keys((window as unknown as { redlog: { artifacts: object } }).redlog.artifacts)).toEqual(['reveal'])
  })

  it('says so, and that the record remains, when the copy is gone', async () => {
    reveal.mockResolvedValue(false)
    draw(ARTIFACT)
    fireEvent.click(screen.getByTestId('evidence-file-reveal'))
    await waitFor(() => expect(toasts).toHaveLength(1))
    expect(toasts[0].message).toBe('Could not show the file')
    expect(JSON.stringify(toasts[0].opts)).toContain('still in the timeline')
  })

  it('treats a rejected reveal like a failed one', async () => {
    reveal.mockRejectedValue(new Error('ipc closed'))
    draw(ARTIFACT)
    fireEvent.click(screen.getByTestId('evidence-file-reveal'))
    await waitFor(() => expect(toasts).toHaveLength(1))
  })

  it('has no reveal button when the event carries no stored copy', () => {
    draw({ ...ARTIFACT, stored: undefined })
    expect(screen.queryByTestId('evidence-file-reveal')).toBeNull()
  })
})
