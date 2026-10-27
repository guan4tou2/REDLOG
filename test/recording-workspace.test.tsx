// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import RecordingWorkspace from '../src/renderer/src/components/RecordingWorkspace'

vi.mock('../src/renderer/src/components/SearchPanel', () => ({ SearchPanel: ({ controlledQuery, viewMode, active, browse }: any) => <div data-testid="workspace-search" data-active={active} data-mode={viewMode} data-browse={browse}>{controlledQuery}</div> }))
vi.mock('../src/renderer/src/components/TranscriptView', () => ({ default: ({ reading, externalQuery, active }: any) => <div data-testid={`workspace-${reading}`} data-active={active}><input aria-label={`position-${reading}`} defaultValue="" />{externalQuery}</div> }))
afterEach(cleanup)

describe('recording workspace', () => {
  it('shares the query across reading modes and preserves a mounted reader when returning', async () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.getByTestId('workspace-search').dataset.mode).toBe('activities')
    expect(screen.getByTestId('workspace-search').dataset.browse).toBe('true')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sqlmap' } })
    expect(screen.getByTestId('workspace-search').textContent).toBe('sqlmap')
    fireEvent.click(screen.getByRole('tab', { name: 'Input / output' }))
    const position = await screen.findByLabelText('position-io')
    fireEvent.change(position, { target: { value: 'saved position' } })
    fireEvent.click(screen.getByRole('tab', { name: 'AI conversations' }))
    expect((await screen.findByTestId('workspace-ai')).textContent).toContain('sqlmap')
    fireEvent.click(screen.getByRole('tab', { name: 'Input / output' }))
    expect(screen.getByLabelText('position-io')).toHaveProperty('value', 'saved position')
    fireEvent.click(screen.getByRole('tab', { name: 'Raw events' }))
    expect(screen.getByTestId('workspace-search').dataset.mode).toBe('events')
    expect(screen.getByTestId('workspace-io').dataset.active).toBe('false')
  })
})
