import { expect, it } from 'vitest'
import { parseTarget, settingsTarget } from '../src/renderer/src/lib/navigation'
it('round-trips a candidate into the canonical Scope page without making a policy change', () => {
  const target = 'api.example.test'
  expect(parseTarget(settingsTarget('scope', { candidate: target }))).toEqual({ view: 'settings', settingsPage: 'scope', scopeCandidate: target })
  expect(parseTarget(settingsTarget('browser', { candidate: target }))).toEqual({ view: 'settings', settingsPage: 'browser' })
  expect(parseTarget('timeline')).toEqual({ view: 'timeline' })
})

// #590: a warning about one source opens Settings on that source's row.
it('round-trips a capture source id into the Capture sources page', () => {
  for (const source of ['agent-claude-code', 'screenshot', 'file-watcher', 'sliver.c2-log']) {
    expect(settingsTarget('captureControl', { source })).toBe(`settings/captureControl?source=${source}`)
    expect(parseTarget(settingsTarget('captureControl', { source }))).toEqual({ view: 'settings', settingsPage: 'captureControl', sourceId: source })
  }
  // No source: the plain page link is unchanged.
  expect(settingsTarget('captureControl')).toBe('settings/captureControl')
  expect(parseTarget('settings/captureControl')).toEqual({ view: 'settings', settingsPage: 'captureControl' })
})

it('only the Capture sources page takes a source, and only a well-formed id', () => {
  expect(settingsTarget('hooks', { source: 'screenshot' })).toBe('settings/hooks')
  expect(parseTarget('settings/hooks?source=screenshot')).toEqual({ view: 'settings', settingsPage: 'hooks' })
  for (const bad of ['', 'Screenshot', '../x', 'a"]b', ' x', 'x'.repeat(65)]) {
    expect(settingsTarget('captureControl', { source: bad })).toBe('settings/captureControl')
    expect(parseTarget(`settings/captureControl?source=${encodeURIComponent(bad)}`)).toEqual({ view: 'settings', settingsPage: 'captureControl' })
  }
})

it('carries a scope candidate and a source independently', () => {
  expect(parseTarget(settingsTarget('scope', { candidate: 'a.test', source: 'screenshot' }))).toEqual({ view: 'settings', settingsPage: 'scope', scopeCandidate: 'a.test' })
})
