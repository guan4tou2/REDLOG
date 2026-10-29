import { expect, it } from 'vitest'
import { parseTarget, settingsTarget } from '../src/renderer/src/lib/navigation'
it('round-trips a candidate into the canonical Scope page without making a policy change', () => {
  const target = 'api.example.test'
  expect(parseTarget(settingsTarget('scope', target))).toEqual({ view: 'settings', settingsPage: 'scope', scopeCandidate: target })
  expect(parseTarget(settingsTarget('browser', target))).toEqual({ view: 'settings', settingsPage: 'browser' })
  expect(parseTarget('timeline')).toEqual({ view: 'timeline' })
})
