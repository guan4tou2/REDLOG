// @vitest-environment jsdom
//
// What the graph draws, and what it does when the chain is not a graph.
// Geometry is covered in causal-graph-layout.test.ts; this file is about the
// component's own decisions — which nodes exist, what a click does, and the
// three states that are not a drawing.
//
// `t` is a stub that returns its key: the keys themselves are checked against
// both locales by i18n-keys.test.ts, so asserting on English here would only
// duplicate that and break when the wording changes.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventCausalChain, RedLogEvent } from '../src/core/db/event-types'
import { CausalGraph } from '../src/renderer/src/components/timeline/CausalGraph'

const t = (key: string): string => key

function evt(id: string, overrides: Partial<RedLogEvent> = {}): RedLogEvent {
  return {
    id,
    timestamp: 1_700_000_000_000,
    engagementId: 'eng',
    sessionId: 'sess',
    operatorId: 'op',
    agentType: 'shell',
    hostname: 'host',
    sourceIP: null,
    targetId: null,
    data: { subtype: 'command_end' },
    createdAt: 1_700_000_000_000,
    tier: 'chained',
    ...overrides
  }
}

function stubChain(chain: Partial<EventCausalChain>): void {
  const full: EventCausalChain = {
    anchorId: 'b',
    anchorFound: true,
    events: [],
    edges: [],
    unavailableCauseIds: [],
    truncated: false,
    ...chain
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { causalChain: vi.fn(async () => full) }
  }
}

function draw(onSelect = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <CausalGraph
      anchorId="b"
      pluginTypes={[]}
      titleOf={(e) => `title-${e.id}`}
      onSelect={onSelect}
      t={t}
    />
  )
  return onSelect
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CausalGraph', () => {
  it('draws a node per event and a path per edge', async () => {
    stubChain({
      events: [evt('a'), evt('b'), evt('c')],
      edges: [{ causeId: 'a', effectId: 'b' }, { causeId: 'b', effectId: 'c' }]
    })
    draw()

    await waitFor(() => expect(screen.getAllByTestId('causal-node')).toHaveLength(3))
    const svg = screen.getByTestId('causal-graph').querySelector('svg')!
    expect(svg.querySelectorAll('path[marker-end]')).toHaveLength(2)
  })

  it('selects the event behind a clicked node', async () => {
    stubChain({
      events: [evt('a'), evt('b')],
      edges: [{ causeId: 'a', effectId: 'b' }]
    })
    const onSelect = draw()

    await waitFor(() => expect(screen.getAllByTestId('causal-node')).toHaveLength(2))
    const nodeA = screen.getByTestId('causal-graph').querySelector('[data-event-id="a"]')!
    fireEvent.click(nodeA)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe('a')
  })

  it('draws an unavailable cause as a placeholder that cannot be selected', async () => {
    stubChain({
      events: [evt('b')],
      edges: [{ causeId: 'gone', effectId: 'b' }],
      unavailableCauseIds: ['gone']
    })
    const onSelect = draw()

    await waitFor(() => expect(screen.getByTestId('causal-node-unavailable')).toBeTruthy())
    // Only the real event is a clickable node; absence is drawn, not offered.
    expect(screen.getAllByTestId('causal-node')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('causal-node-unavailable'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('says so rather than drawing an empty canvas when there are no links', async () => {
    stubChain({ events: [evt('b')], edges: [] })
    draw()

    await waitFor(() => expect(screen.getByText('timeline.causalGraph.solitary')).toBeTruthy())
    expect(screen.queryByTestId('causal-graph')).toBeNull()
  })

  it('reports a chain whose anchor is gone as unavailable', async () => {
    stubChain({ anchorFound: false })
    draw()

    await waitFor(() => expect(screen.getByText('timeline.causalGraph.failed')).toBeTruthy())
  })

  it('reports a failed query rather than hanging on the loading state', async () => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      events: { causalChain: vi.fn(async () => { throw new Error('ipc down') }) }
    }
    draw()

    await waitFor(() => expect(screen.getByText('timeline.causalGraph.failed')).toBeTruthy())
  })

  it('clips a title by display width, so a zh-TW title does not overrun the node', async () => {
    // The UI ships zh-TW and a node is 186px wide: 25 Latin characters fit,
    // 25 Han characters are twice that. Clipping by `length` would let the
    // second case run past the node's own edge.
    stubChain({
      events: [evt('a'), evt('b')],
      edges: [{ causeId: 'a', effectId: 'b' }]
    })
    render(
      <CausalGraph
        anchorId="b"
        pluginTypes={[]}
        titleOf={() => '目標主機的連線被記錄下來並且寫進了證據鏈裡面'}
        onSelect={vi.fn()}
        t={t}
      />
    )

    await waitFor(() => expect(screen.getAllByTestId('causal-node')).toHaveLength(2))
    const drawn = screen.getByTestId('causal-graph').querySelectorAll('text')[0].textContent!
    expect(drawn.endsWith('…')).toBe(true)
    // 23 half-width units: 11 wide characters plus the ellipsis.
    expect([...drawn].filter((c) => c !== '…')).toHaveLength(11)
  })

  it('surfaces the bound when the backend truncated the walk', async () => {
    stubChain({
      events: [evt('a'), evt('b')],
      edges: [{ causeId: 'a', effectId: 'b' }],
      truncated: true,
      unavailableCauseIds: []
    })
    draw()

    await waitFor(() => expect(screen.getByText('timeline.causalGraph.truncated')).toBeTruthy())
  })

  describe('enlarged', () => {
    const open = async (): Promise<void> => {
      stubChain({
        events: [evt('a'), evt('b'), evt('c')],
        edges: [{ causeId: 'a', effectId: 'b' }, { causeId: 'b', effectId: 'c' }]
      })
      draw()
      await waitFor(() => expect(screen.getByTestId('causal-graph-enlarge')).toBeTruthy())
      fireEvent.click(screen.getByTestId('causal-graph-enlarge'))
      await waitFor(() => expect(screen.getByTestId('causal-graph-dialog')).toBeTruthy())
    }

    it('draws the same component again at dialog size', async () => {
      await open()
      // Both canvases are mounted: the inline one stays behind the dialog.
      expect(screen.getAllByTestId('causal-node')).toHaveLength(6)
      expect(screen.getByTestId('causal-graph-dialog').querySelectorAll('[data-testid=causal-node]'))
        .toHaveLength(3)
    })

    it('gives each canvas its own arrow marker', async () => {
      // Two markers sharing an id makes the dialog's arrows resolve to the
      // inline canvas's marker, which then vanishes with it. Rendered once,
      // a test would not notice; rendered twice, this is the whole bug.
      await open()
      const ids = [...document.querySelectorAll('marker')].map((m) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const svg of document.querySelectorAll('svg')) {
        const marker = svg.querySelector('marker')
        const path = svg.querySelector('path[marker-end]')
        if (!marker || !path) continue
        expect(path.getAttribute('marker-end')).toBe(`url(#${marker.id})`)
      }
    })

    it('repeats the bound in the dialog rather than implying a whole component', async () => {
      stubChain({
        events: [evt('a'), evt('b')],
        edges: [{ causeId: 'a', effectId: 'b' }],
        truncated: true
      })
      draw()
      await waitFor(() => expect(screen.getByTestId('causal-graph-enlarge')).toBeTruthy())
      fireEvent.click(screen.getByTestId('causal-graph-enlarge'))
      await waitFor(() => expect(screen.getByTestId('causal-graph-dialog')).toBeTruthy())
      expect(screen.getByTestId('causal-graph-dialog').textContent)
        .toContain('timeline.causalGraph.truncated')
    })

    it('closes from its own control', async () => {
      await open()
      fireEvent.click(screen.getByTestId('causal-graph-dialog-close'))
      await waitFor(() => expect(screen.queryByTestId('causal-graph-dialog')).toBeNull())
      // The section underneath is still there.
      expect(screen.getAllByTestId('causal-node')).toHaveLength(3)
    })

    it('closes on Escape, through Modal s own contract', async () => {
      await open()
      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByTestId('causal-graph-dialog')).toBeNull())
    })

    it('selects from the dialog too', async () => {
      const onSelect = vi.fn()
      stubChain({
        events: [evt('a'), evt('b')],
        edges: [{ causeId: 'a', effectId: 'b' }]
      })
      draw(onSelect)
      await waitFor(() => expect(screen.getByTestId('causal-graph-enlarge')).toBeTruthy())
      fireEvent.click(screen.getByTestId('causal-graph-enlarge'))
      await waitFor(() => expect(screen.getByTestId('causal-graph-dialog')).toBeTruthy())
      const node = screen.getByTestId('causal-graph-dialog').querySelector('[data-event-id="a"]')!
      fireEvent.click(node)
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect.mock.calls[0][0].id).toBe('a')
    })
  })
})
