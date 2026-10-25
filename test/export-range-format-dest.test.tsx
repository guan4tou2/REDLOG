// @vitest-environment jsdom
//
// Before anything is previewed the menu says what "current" covers; the last
// format picked is remembered; and the preview says where the file will go and
// lets the operator change it.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import { subsetSummary } from '../src/renderer/src/lib/exportSubsetText'

const t = (key: string, vars?: Record<string, string | number>): string => vars ? `${key}:${JSON.stringify(vars)}` : key

function plan(): ResolvedExportPlan {
  return {
    id: 'plan-1', fingerprint: '1234567890abcdef', expiresAt: Date.now() + 1000,
    snapshot: { chainedMaxRowId: 1, loggedMaxRowId: 1, takenAt: 1_700_000_000_000 },
    scopeSnapshot: { targets: [], excludeTargets: [], personalDomains: [] },
    capabilities: { snapshot: true, boundedSubset: false, scopeMasking: true, piiScrubbing: true, attachments: false },
    request: { format: 'json', subset: { kind: 'all' }, maskOutOfScope: true, scopeOnly: false, scrubPii: false },
    counts: { examined: 3, included: 3, excludedDoNotExport: 0, excludedPersonal: 0, maskedOutOfScope: 0, sanitized: 0, attachmentsIncluded: 0, attachmentsMissing: 0, attachmentsUnattributed: 0, unsupported: 0 }
  }
}

let execute: ReturnType<typeof vi.fn>
let pick: ReturnType<typeof vi.fn>
function install(): void {
  execute = vi.fn(async () => ({ ok: true, planId: 'plan-1', fingerprint: 'x', artifactPath: '/tmp/x', counts: plan().counts, warnings: [], delivery: { artifactPath: '/tmp/x', format: 'json', completedAt: 1700000000000, availability: 'available' } }))
  pick = vi.fn(async () => '/Volumes/evidence')
  ;(window as unknown as { redlog: unknown }).redlog = {
    data: { recentExport: vi.fn(async () => ({ ok: true, delivery: null })),
      resolveExportPlan: vi.fn(async () => ({ ok: true, plan: plan() })),
      executeExportPlan: execute,
      exportDestination: vi.fn(async () => '/proj/exports'),
      pickExportDir: pick
    }
  }
}

describe('subsetSummary', () => {
  it('names enabled and disabled conditions while omitting unset filters', () => {
    const translate = (key: string): string => (en as Record<string, string>)[key] ?? key
    const summary = subsetSummary({ kind: 'selection', projection: 'events', filter: { hidePersonal: true, inScopeOnly: false, since: undefined } }, translate)
    expect(summary).toContain('Hide personal traffic: Enabled')
    expect(summary).toContain('In scope only: Disabled')
    expect(summary).not.toMatch(/true|false|undefined/)
    expect(summary).not.toContain('From:')
  })

  it('says a selection with no condition is every stored event, not "the current view"', () => {
    expect(subsetSummary({ kind: 'selection', projection: 'events', filter: {} }, t)).toBe('export.range.noFilter')
  })
  it('omits empty HTTP controls without hiding an active status filter', () => {
    expect(subsetSummary({ kind: 'selection', projection: 'http', filter: {}, http: { statusPrefix: '4', text: '', host: undefined } }, t))
      .toBe('export.condition.statusPrefix: 4')
    expect(subsetSummary({ kind: 'selection', projection: 'http', filter: {}, http: { text: '' } }, t))
      .toBe('export.range.noFilter')
  })
  it('lists the conditions, the whole project, and a time range', () => {
    expect(subsetSummary({ kind: 'selection', projection: 'events', filter: { targetId: 'a.test' } }, t)).toContain('a.test')
    expect(subsetSummary({ kind: 'all' }, t)).toBe('export.preview.subsetAll')
    expect(subsetSummary({ kind: 'time-range', since: 1_700_000_000_000, before: 1_700_000_100_000 } as never, t)).toContain(' → ')
  })
})

describe('Export menu: range, remembered format, destination', () => {
  beforeEach(() => { try { localStorage.clear() } catch { /* jsdom */ }; install() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const open = (): void => { fireEvent.click(screen.getByLabelText('Export')) }
  const draw = (): void => { render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>) }

  it('says what the current view covers before anything is chosen', () => {
    draw(); open()
    // The default view already hides personal traffic, and the line says so rather
    // than calling it "no filter".
    expect(screen.getByTestId('export-range-current').textContent).toMatch(/Current view covers: .*Hide personal traffic/)
    fireEvent.change(screen.getByLabelText('Export range'), { target: { value: 'all' } })
    expect(screen.getByTestId('export-range-current').textContent).toBe('The whole project; the current filter is not applied')
  })

  it('remembers the format picked in the dropdown', () => {
    draw(); open()
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'other' } }); fireEvent.change(screen.getByLabelText('Other formats'), { target: { value: 'ndjson' } })
    cleanup(); draw(); open()
    expect((screen.getByLabelText('Other formats') as HTMLSelectElement).value).toBe('ndjson')
  })

  it('ignores a stored format it does not offer', () => {
    localStorage.setItem('redlog.export.format', 'har')
    draw(); open()
    expect((screen.getByLabelText('Export format') as HTMLSelectElement).value).toBe('bundle')
  })

  it('shows where the file will go, and sends a changed folder with the confirm', async () => {
    draw(); open()
    await waitFor(() => expect(screen.getByTestId('export-destination').textContent).toBe('/proj/exports'))
    fireEvent.click(screen.getByTestId('export-change-destination'))
    await waitFor(() => expect(screen.getByTestId('export-destination').textContent).toBe('/Volumes/evidence'))
    fireEvent.click(screen.getByTestId('export-confirm'))
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ planId: 'plan-1', destDir: '/Volumes/evidence' }))
  })

  it('sends no folder when the operator did not change it, and a cancelled picker changes nothing', async () => {
    pick.mockResolvedValueOnce(null)
    draw(); open()
    await waitFor(() => expect(screen.getByTestId('export-destination').textContent).toBe('/proj/exports'))
    fireEvent.click(screen.getByTestId('export-change-destination'))
    await waitFor(() => expect(pick).toHaveBeenCalled())
    expect(screen.getByTestId('export-destination').textContent).toBe('/proj/exports')
    fireEvent.click(screen.getByTestId('export-confirm'))
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ planId: 'plan-1' }))
  })
})
