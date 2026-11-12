// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { I18nProvider } from '../src/renderer/src/i18n'
import { settingsTarget } from '../src/renderer/src/lib/navigation'

// The capture card's exception list names an AI tool that is in use on this
// machine and is not being recorded, and only then.

const health = (sources: Array<Partial<CaptureSourceInfo>>): CaptureHealthInfo => ({
  verdict: 'healthy', hasRecorded: true, lastEventAt: null, checkedAt: Date.now(),
  dbErrorTotal: 0, dbErrorFirstAt: null,
  sources: sources.map((s) => ({ lastEventAt: null, state: 'off', enabled: false, installed: false, ...s }))
} as unknown as CaptureHealthInfo)

const codex = (extra: Partial<CaptureSourceInfo> = {}): Partial<CaptureSourceInfo> =>
  ({ id: 'agent-codex', label: 'Codex CLI', unrecordedActivityAt: Date.now() - 30_000, ...extra })
const claude: Partial<CaptureSourceInfo> = { id: 'agent-claude-code', label: 'Claude Code' }

function show(capture: CaptureHealthInfo, projectId = 'eng-1', onNavigate = vi.fn()): ReturnType<typeof render> {
  return render(<I18nProvider><CaptureHealthCard capture={capture} projectId={projectId} onNavigate={onNavigate} onRefresh={() => {}} /></I18nProvider>)
}

beforeEach(() => {
  window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {}
})
afterEach(cleanup)

describe('capture card — AI tool in use, not recorded', () => {
  it('appears in the compact view only when the field is set', () => {
    show(health([codex(), claude]))
    expect(screen.getByTestId('capture-row-agent-codex')).toBeTruthy()
    expect(screen.getByTestId('capture-unrecorded-agent-codex').textContent).toBe('In use, not recorded')
    expect(screen.queryByTestId('capture-row-agent-claude-code')).toBeNull()
    cleanup()
    show(health([codex({ unrecordedActivityAt: undefined }), claude]))
    expect(screen.queryByTestId('capture-problems')).toBeNull()
  })

  it('its action opens that source\'s row in Settings', () => {
    const onNavigate = vi.fn()
    show(health([codex()]), 'eng-1', onNavigate)
    fireEvent.click(screen.getByTestId('capture-open-agent-codex'))
    expect(onNavigate).toHaveBeenCalledWith(settingsTarget('captureControl', { source: 'agent-codex' }))
  })

  it('dismissing removes it, and it stays removed after a remount and new activity', () => {
    show(health([codex()]))
    fireEvent.click(screen.getByTestId('capture-dismiss-agent-codex'))
    expect(screen.queryByTestId('capture-row-agent-codex')).toBeNull()
    cleanup()
    show(health([codex({ unrecordedActivityAt: Date.now() })]))
    expect(screen.queryByTestId('capture-row-agent-codex')).toBeNull()
  })

  it('a dismissal belongs to its project and its tool', () => {
    show(health([codex(), { ...claude, unrecordedActivityAt: Date.now() }]))
    fireEvent.click(screen.getByTestId('capture-dismiss-agent-codex'))
    expect(screen.getByTestId('capture-row-agent-claude-code')).toBeTruthy()
    cleanup()
    show(health([codex()]), 'eng-2')
    expect(screen.getByTestId('capture-row-agent-codex')).toBeTruthy()
  })

  it('enabling the source removes it', () => {
    const { rerender } = show(health([codex()]))
    expect(screen.getByTestId('capture-row-agent-codex')).toBeTruthy()
    rerender(<I18nProvider><CaptureHealthCard capture={health([codex({ unrecordedActivityAt: undefined, enabled: true, state: 'ready' })])} projectId="eng-1" onNavigate={() => {}} onRefresh={() => {}} /></I18nProvider>)
    expect(screen.queryByTestId('capture-row-agent-codex')).toBeNull()
  })

  it('the manage view shows the fact on that row, dismissed or not', () => {
    show(health([codex()]))
    fireEvent.click(screen.getByTestId('capture-dismiss-agent-codex'))
    fireEvent.click(screen.getByTestId('capture-more-sources'))
    expect(screen.getByTestId('capture-unrecorded-agent-codex').textContent).toBe('In use, not recorded')
    expect(screen.queryByTestId('capture-dismiss-agent-codex')).toBeNull()
  })

  it('does not change the headline', () => {
    show(health([codex()]))
    expect(screen.getByTestId('capture-verdict').textContent).not.toMatch(/attention|partial/i)
  })

  it('fits a narrow width: the row wraps and the name truncates with a title', () => {
    show(health([codex()]))
    const row = screen.getByTestId('capture-row-agent-codex')
    expect(row.className).toContain('flex-wrap')
    const name = screen.getAllByTitle('Codex CLI')
    expect(name.some((el) => el.className.includes('truncate'))).toBe(true)
  })
})
