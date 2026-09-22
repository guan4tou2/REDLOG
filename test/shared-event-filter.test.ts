import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8')

describe('shared event filter wiring', () => {
  it('Search sends target, type, time and scope to the paged query', () => {
    const source = read('src/renderer/src/components/SearchPanel.tsx')
    expect(source).toMatch(/const opts = toEventFilter\(sharedFilter\)/)
    expect(source).toMatch(/opts\.agentType = effectiveTypeFilter/)
    expect(source).not.toMatch(/results\.filter\(\(event\).*hostInScope/s)
    expect(source).toMatch(/if \(!eventFilterActive\) \{[\s\S]*searchCasts/)
  })

  it('Search restarts on filter changes and preserves the filter for load more', () => {
    const source = read('src/renderer/src/components/SearchPanel.tsx')
    const loadMore = source.slice(source.indexOf('const loadMore'), source.indexOf('useEffect(() => {', source.indexOf('const loadMore')))
    expect(loadMore).toMatch(/const opts = buildSearchOpts\(\)/)
    expect(loadMore).toMatch(/cursor: nextCursor, \.\.\.opts/)
    expect(source).toMatch(/\[effectiveTypeFilter, sharedFilter\.targetId, sharedFilter\.timeRange, sharedFilter\.inScopeOnly\]/)
  })

  it('Transcript sends shared predicates with each bounded backend bucket', () => {
    const source = read('src/renderer/src/components/TranscriptView.tsx')
    expect(source).toMatch(/sharedFilter\.agentType/)
    expect(source).toMatch(/\.\.\.toEventFilter\(sharedFilter\)/)
    expect(source).not.toMatch(/hostInScope/)
  })

  it('HTTP History sends shared predicates before its flow-level page limit', () => {
    const source = read('src/renderer/src/components/HttpHistoryPanel.tsx')
    const query = source.indexOf('window.redlog.events.queryHttpFlowPage({')
    const limit = source.indexOf('limit: 500', query)
    const projection = source.indexOf('eventsToFlows(page.items)', query)
    expect(query).toBeGreaterThan(0)
    expect(limit).toBeGreaterThan(query)
    expect(projection).toBeGreaterThan(limit)
    expect(source.slice(query, projection)).toMatch(/\.\.\.toEventFilter\(sharedFilter\)/)
  })

  it('defines target, type, time and scope mapping once', () => {
    const source = read('src/renderer/src/lib/FilterContext.tsx')
    expect(source).toMatch(/export function toEventFilter/)
    expect(source).toMatch(/targetId: filter\.targetId/)
    expect(source).toMatch(/agentType: filter\.agentType/)
    expect(source).toMatch(/since: filter\.timeRange\.since/)
    expect(source).toMatch(/before: filter\.timeRange\.before/)
    expect(source).toMatch(/inScopeOnly: true/)
  })

  it('main attaches active-project scope instead of trusting renderer rules', () => {
    const source = read('src/main/ipc/events.ts')
    expect(source).toMatch(/snapshotScope\(loadConfig\(getProjectPath\(project\)\)\)/)
    expect(source).toMatch(/searchEventsPage\(withActiveScope\(opts\)\)/)
    expect(source).toMatch(/queryEvents\(withActiveScope\(opts/)
  })
})
