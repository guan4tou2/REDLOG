// @vitest-environment jsdom
//
// Stitch 08 (visual refinement): the capture card leads with a one-line
// summary of both core captures, a badge for the verdict, a footer, and the
// rest of the sources folded behind one control. Issues show how long they
// have lasted.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { DashboardIssues } from '../src/renderer/src/components/DashboardIssues'
import { raiseIssue, _resetIssues } from '../src/renderer/src/lib/issues'
import { formatDuration } from '../src/renderer/src/lib/time'

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear(); _resetIssues() })

const terminal = { id: 'terminal', state: 'ready', lastEventAt: Date.now() }
const mitm = { id: 'mitmproxy', hookId: 'mitmproxy', installed: true, state: 'ready', lastEventAt: null }
const clip = { id: 'clipboard', state: 'off', lastEventAt: null, configPath: 'clipboard.enabled', enabled: false }

function draw(verification: Record<string, unknown> | undefined): void {
  const capture = {
    verdict: 'healthy', recording: true, sources: [terminal, mitm, clip], lastEventAt: null, checkedAt: Date.now(),
    managedHttpProxy: { state: 'running', url: 'http://127.0.0.1:8080', ...(verification ? { httpsVerification: verification } : {}) }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<I18nProvider><CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} onSetup={() => {}} /></I18nProvider>)
}

describe('capture card summary', () => {
  it('names both halves when HTTPS is not verified yet, and warns that listening is not trust', () => {
    draw(undefined)
    expect(screen.getByTestId('capture-summary').textContent).toBe('Commands connected, HTTP awaiting tool verification')
    expect(screen.getByTestId('capture-verdict').textContent).toContain('Some sources unconfirmed')
    expect(screen.getByTestId('capture-footer').textContent).toContain('does not mean HTTPS certificate trust is set up')
    expect(screen.getByTestId('capture-core-http').textContent).toContain('Awaiting test traffic')
  })

  it('says the core sources are working only once HTTPS is verified', () => {
    draw({ at: Date.now(), userAgent: 'curl/8.4.0' })
    expect(screen.getByTestId('capture-summary').textContent).toBe('Core sources are working')
    expect(screen.getByTestId('capture-verdict').textContent).toContain('Capture is working')
    expect(screen.getByTestId('capture-footer').textContent).toMatch(/Last capture check: \d{1,2}:\d{2}/)
  })

  it('folds the other sources behind one control, with their switches inside', () => {
    draw(undefined)
    expect(screen.queryByTestId('capture-inventory')).toBeNull()
    const toggle = screen.getByTestId('capture-more-sources')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('Other capture sources and status (3)')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('capture-row-clipboard')).toBeTruthy()
    expect(screen.getByTestId('capture-manage-sources').textContent).toContain('Manage sources')
  })
})

describe('needs-action panel', () => {
  it('shows the count as a badge and each condition as how long it has lasted', () => {
    raiseIssue({ id: 'scope', tier: 'pending', title: 'Scope is not set', since: Date.now() - 12 * 60_000 })
    render(<I18nProvider><DashboardIssues onNavigate={() => {}} /></I18nProvider>)
    expect(screen.getByTestId('dashboard-issues-count').textContent).toBe('1')
    expect(screen.getByTestId('dashboard-issue-scope').textContent).toContain('For 12 min')
  })

  it('formats a duration in its largest whole unit', () => {
    const t = (k: string, v?: Record<string, string | number>): string => `${k}:${JSON.stringify(v)}`
    expect(formatDuration(30_000, t)).toBe('time.durS:{"s":30}')
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000, t)).toBe('time.durH:{"h":2}')
  })
})
