// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activityResultLabel } from '../src/renderer/src/lib/commandStatus'
import { CommandUnfinishedNote } from '../src/renderer/src/components/TimelineEventDetails'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(cleanup)
const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ''}`

describe('activityResultLabel', () => {
  // 2026-11-18: one short word per state in the result position, the full
  // sentence as its title and accessible name. Success is the bare code; a
  // failure keeps a word beside its code, so neither rests on colour.
  it('says success as the code alone, with nothing more to say', () => {
    expect(activityResultLabel({ kind: 'command', state: 'paired', result: { exitCode: 0 } }, t)).toEqual({ text: '0', title: undefined, tone: 'ok' })
  })
  it('says failure with a word and the code, titled with the same', () => {
    expect(activityResultLabel({ kind: 'command', state: 'paired', result: { exitCode: 127 } }, t))
      .toEqual({ text: 'activity.result.failed{"code":127}', title: 'activity.result.failed{"code":127}', tone: 'fail' })
  })
  it('shortens ended-without-a-code, and keeps the sentence as the title', () => {
    expect(activityResultLabel({ kind: 'command', state: 'paired', result: { exitCode: null } }, t))
      .toEqual({ text: 'activity.result.endedShort', title: 'activity.result.ended', tone: 'neutral' })
  })
  it('treats a command with no end as running/unknown, never failed, in a short word', () => {
    expect(activityResultLabel({ kind: 'command', state: 'call-only' }, t))
      .toEqual({ text: 'activity.result.unfinished', title: 'timeline.command.unfinished', tone: 'neutral' })
  })
  it('keeps the short words apart from each other and from success, in both locales', () => {
    for (const locale of ['en', 'zh-TW']) {
      const words = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', `${locale}.json`), 'utf8')) as Record<string, string>
      const shown = ['activity.result.endedShort', 'activity.result.unfinished'].map((k) => words[k])
      shown.push(words['activity.result.failed'].replace('{{code}}', '7'), '0')
      expect(new Set(shown).size, locale).toBe(4)
      for (const w of shown) expect(w.length, `${locale}: ${w}`).toBeLessThanOrEqual(12)
    }
  })
  // Nothing is not 0: a command whose pairing is not known shows no result,
  // so a bare "0" can only ever mean a recorded exit 0.
  it('says nothing for a command with no recorded end that is not merely unfinished', () => {
    for (const state of ['unknown', 'interrupted', 'conflicted', 'result-only', 'paired'] as const) {
      expect(activityResultLabel({ kind: 'command', state }, t), state).toBeNull()
    }
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
