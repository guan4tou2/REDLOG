// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { activityResultLabel } from '../src/renderer/src/lib/commandStatus'
import { CommandUnfinishedNote } from '../src/renderer/src/components/TimelineEventDetails'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(cleanup)
const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ''}`

describe('activityResultLabel', () => {
  it('says success, failure with the code, and ended without a code', () => {
    expect(activityResultLabel({ kind: 'command', state: 'paired', result: { exitCode: 0 } }, t)?.tone).toBe('ok')
    const failed = activityResultLabel({ kind: 'command', state: 'paired', result: { exitCode: 127 } }, t)
    expect(failed).toEqual({ text: 'activity.result.failed{"code":127}', tone: 'fail' })
    expect(activityResultLabel({ kind: 'command', state: 'paired', result: { exitCode: null } }, t)?.tone).toBe('neutral')
  })
  it('treats a command with no end as running/unknown, never failed', () => {
    expect(activityResultLabel({ kind: 'command', state: 'call-only' }, t)).toEqual({ text: 'timeline.command.unfinished', tone: 'neutral' })
  })
  it('leaves other kinds alone', () => {
    expect(activityResultLabel({ kind: 'tool', state: 'call-only' }, t)).toBeNull()
    expect(activityResultLabel({ kind: 'http', state: 'paired' }, t)).toBeNull()
  })
})

describe('CommandUnfinishedNote', () => {
  it('states running or unknown and that it is not recorded as failed', () => {
    render(<I18nProvider><CommandUnfinishedNote /></I18nProvider>)
    expect(screen.getByRole('status').textContent).toMatch(/running or status unknown/)
    expect(screen.getByRole('status').textContent).toMatch(/not recorded as failed/)
  })
})
