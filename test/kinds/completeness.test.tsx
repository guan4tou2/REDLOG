// @vitest-environment jsdom
//
// Spec 072 T007 (US1) — a reader says, on its first line, whether what it shows is all there is.
//
// The contract (FR-033, plan D5): the first line of a content reader is one of
// seven things the SOURCE said — 完整、截斷（已存 X，共 Y）、部分、未擷取、已重導、缺口、
// 未知 — and the dot on the Timeline says the same thing. Today no reader has
// such a line. Each reader has a note of its own for some states
// (src/renderer/src/lib/commandOutputNote.ts, #591), worded differently, and
// shown at the foot of the detail, not as its first line.
//
// What is already true, and pinned as ordinary `it`:
//   - the producer's statement is read, not inferred: `redirected` is no longer
//     called "未產生內容", and a legacy row is neither 完整 nor 未產生內容 (#591
//     moved this since report 10 was written; the plan's US1 text predates it).
// What is not, written as the CORRECT behaviour and marked `it.fails`, one case
// per scenario, each with its reason. When `completenessOf` lands and a reader
// draws the line, the matching case starts passing and `it.fails` fails: remove
// the marker then. A marker left on a case that now passes is the failure.
//
// The reader under test is `CommandEndDetail` with the real zh-TW strings, the
// first line being the first piece of visible text in what it renders. The gap
// scenario passes `overlapsGap`, a prop that does not exist yet (074 supplies
// the fact); today it is ignored, which is the defect.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from '../../src/renderer/src/i18n'
import { CommandEndDetail } from '../../src/renderer/src/components/TimelineEventDetails'
import { ioMark } from '../../src/renderer/src/lib/timelineDomain'
import { exampleById } from './examples'

const install = (): void => {
  window.localStorage.setItem('redlog-locale', 'zh-TW')
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { commandOutput: vi.fn(async () => ({ items: [], hasMore: false })), onNewBatch: vi.fn(() => () => {}) }
  }
}
afterEach(() => { cleanup(); window.localStorage.clear() })

/** The first piece of text a reader shows. */
function firstLine(container: HTMLElement): string {
  for (const el of Array.from(container.querySelectorAll('*'))) {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim()
    if (own) return own
  }
  return ''
}

function read(data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  install()
  // `extra` carries props the reader does not take yet (overlapsGap): spread so this compiles today.
  const props = { projectId: 'p', eventId: 'e', data, ...extra } as unknown as Parameters<typeof CommandEndDetail>[0]
  const { container } = render(<I18nProvider><CommandEndDetail {...props} /></I18nProvider>)
  return firstLine(container)
}

const rowData = (id: string): Record<string, unknown> => exampleById(id).row.data
const big = { ...rowData('shell:command_end#relay-truncated'), stdout: 'x'.repeat(65536), stdout_bytes: 900000 }

describe('what a reader already does not say (pinned)', () => {
  it('a redirected command is not called "未產生內容" (US1.1 — the part #591 already fixed)', () => {
    expect(read(rowData('shell:command_end#relay-redirected'))).not.toContain('未產生內容')
  })

  it('a command_end from before completeness existed is neither 完整 nor "未產生內容" (US1.5, the part that holds today)', () => {
    const line = read(rowData('shell:command_end#legacy-no-fields'))
    expect(line).not.toContain('未產生內容')
    expect(line).not.toMatch(/^完整/)
  })
})

describe('US1: the first line is the completeness, in the source\'s words', () => {
  // 1. redirected
  it.fails('redirected: the first line is 已重導 (today: 輸出已重導到他處 — 未記錄, a sentence that starts elsewhere and sits at the foot)', () => {
    expect(read(rowData('shell:command_end#relay-redirected'))).toMatch(/^已重導/)
  })
  it.fails('redirected: its dot is not the dot of "not captured" (today both are `uncaptured`)', () => {
    const redirected = ioMark(exampleById('shell:command_end#relay-redirected').row)
    const notCaptured = ioMark(exampleById('shell:command_end#relay-not-captured').row)
    expect(redirected.io).not.toBe(notCaptured.io)
  })

  // 2. not captured
  it.fails('metadata-only / not-captured: the first line is 未擷取 (today: 未捕獲輸出 — 只記錄了指令本身)', () => {
    expect(read(rowData('shell:command_end#relay-not-captured'))).toMatch(/^未擷取/)
  })

  // 3. truncated
  it.fails('truncated: the first line is 截斷（已存 64 KiB，共 879 KiB） (today the first thing drawn is the stdout fold arrow, then its label)', () => {
    expect(read(big)).toMatch(/^截斷（已存 64 KiB，共 879 KiB）/)
  })

  // 4. partial
  it.fails('partial, output_streamed: the first line is 部分 (today: the late-output heading, no completeness)', () => {
    expect(read(rowData('shell:command_end#relay-partial-streamed'))).toMatch(/^部分/)
  })

  // 5. unknown
  it.fails('a legacy command_end: the first line is 未知 (today: 未捕獲輸出 — the reader guesses "not captured")', () => {
    expect(read(rowData('shell:command_end#legacy-no-fields'))).toMatch(/^未知/)
  })

  // 6. built-in terminal
  it.fails('built-in terminal, io.len = 0 in a bracketed span: the first line is 完整, with 沒有輸出 beside it (today: 未產生內容。)', () => {
    const line = read(rowData('shell:command_end#builtin-io-empty'))
    expect(line).toMatch(/^完整/)
    expect(line).toContain('沒有輸出')
  })
  it.fails('built-in terminal, io.unbracketed: the first line is 未知 (today: 輸出無法定位 …)', () => {
    expect(read(rowData('shell:command_end#builtin-io-unbracketed'))).toMatch(/^未知/)
  })

  // 7. gap
  it.fails('a command whose interval overlaps a capture_gap: the first line is 缺口 (today overlapsGap is not read: the first thing drawn is the stdout fold arrow)', () => {
    expect(read(rowData('shell:command_end#relay-complete'), { overlapsGap: true })).toMatch(/^缺口/)
  })
})
