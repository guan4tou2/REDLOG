// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HttpHistoryPanel } from '../src/renderer/src/components/HttpHistoryPanel'
import { LootPanel } from '../src/renderer/src/components/LootPanel'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { I18nProvider } from '../src/renderer/src/i18n'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { installTimelineBridge } from './helpers/timeline-bridge'

afterEach(cleanup)

it('refreshes the mounted Activity, HTTP and Loot queries only when scope policy values change', async () => {
  const { queryPage } = installTimelineBridge()
  const queryHttpFlowPage = vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null, flowCount: 0 }))
  window.redlog.events.queryHttpFlowPage = queryHttpFlowPage
  // A project that already has a policy: reading it at open is not a change.
  let scope = { targets: ['10.10.11.24'], excludeTargets: [] as string[], personalDomains: ['localhost'] }
  const readConfig = vi.fn(async () => ({ scope }))
  window.redlog.config.get = readConfig
  render(
    <I18nProvider>
      <FilterProvider>
        <div hidden><TimelinePanel /></div>
        <div hidden><HttpHistoryPanel /></div>
        <div hidden><LootPanel /></div>
      </FilterProvider>
    </I18nProvider>
  )
  const activity = () => queryPage.mock.calls.filter(([request]: unknown[]) => (request as { excludeHousekeeping?: boolean }).excludeHousekeeping)
  const loot = () => queryPage.mock.calls.filter(([request]: unknown[]) => (request as { agentType?: string }).agentType === 'loot')
  // The HTTP page's list query. Its one-row question about what the non-work
  // filter hides (asked when the list is empty) is not the list being re-asked.
  const http = () => queryHttpFlowPage.mock.calls.filter(([request]: unknown[]) => (request as { limit?: number }).limit !== 1)
  const counts = () => ({ activity: activity().length, http: http().length, loot: loot().length })
  const saveScope = async (next: typeof scope) => {
    scope = next
    await act(async () => { window.dispatchEvent(new Event('redlog:config-saved')) })
  }

  await waitFor(() => expect(counts()).toEqual({ activity: 1, http: 1, loot: 1 }))
  await waitFor(() => expect(readConfig).toHaveBeenCalled())
  await act(async () => { await Promise.resolve() })
  expect(counts()).toEqual({ activity: 1, http: 1, loot: 1 })
  for (const field of ['targets', 'excludeTargets', 'personalDomains'] as const) {
    const before = counts()
    await saveScope({ ...scope, [field]: ['127.0.0.1'] })
    expect(counts()).toEqual({ activity: before.activity + 1, http: before.http + 1, loot: before.loot + 1 })
  }
  expect(activity().at(-1)).toEqual(activity()[0])
  expect(http().at(-1)).toEqual(http()[0])
  expect(loot().at(-1)).toEqual(loot()[0])
  const before = counts()
  await saveScope({ targets: [...scope.targets], excludeTargets: [...scope.excludeTargets], personalDomains: [...scope.personalDomains] })
  expect(counts()).toEqual(before)
})
