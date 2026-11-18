// @vitest-environment jsdom
//
// The bottom bar used to carry 上一個事件 / 下一個事件 beside five other
// buttons. After selecting, the bar has one primary action (閱讀) and one
// secondary (在活動紀錄開啟); walking the sequence is the arrow keys, which
// the shortcut list (?) names. These pin both halves: the buttons are gone,
// and the keys that replace them are still discoverable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TimelineDetailBar } from '../src/renderer/src/components/timeline/TimelineDetailBar'
import { timelineShortcuts } from '../src/renderer/src/lib/shortcuts'
import type { RedLogEvent } from '../src/core/db/event-types'

const ev = (id: string): RedLogEvent => ({
  id, timestamp: 1_700_000_000_000, engagementId: 'e', sessionId: 's', operatorId: 'op',
  agentType: 'shell', hostname: 'h', sourceIP: null, targetId: null,
  data: { subtype: 'command_start', command: `cmd-${id}` }, createdAt: 1
} as RedLogEvent)

beforeEach(() => {
  localStorage.setItem('redlog-locale', 'zh-TW')
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { getNote: vi.fn(async () => null), setNote: vi.fn(async () => null) }
  }
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('stepping through events after selecting', () => {
  it('has no step buttons on the bar', () => {
    render(
      <I18nProvider>
        <TimelineDetailBar
          event={ev('a')} pluginTypes={[]} titleOf={(e) => String(e.data?.command ?? e.id)} t={(k: string) => k}
          onOpenInActivity={vi.fn()} bodyOpen={false} onToggleBody={vi.fn()} onOpenReader={vi.fn()}
        />
      </I18nProvider>
    )
    expect(screen.queryByTestId('detail-step-prev')).toBeNull()
    expect(screen.queryByTestId('detail-step-next')).toBeNull()
  })

  it('is on the arrow keys, which the shortcut list names, as it does Enter and a', () => {
    const rows = timelineShortcuts(true).flatMap((g) => g.rows)
    expect(rows).toContainEqual({ keys: '← →', label: 'timeline.help.walkTime' })
    expect(rows).toContainEqual({ keys: 'Enter', label: 'timeline.help.toggleInspector' })
    expect(rows).toContainEqual({ keys: 'a', label: 'timeline.help.openInActivity' })
  })
})
