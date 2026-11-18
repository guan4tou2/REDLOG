// @vitest-environment jsdom
//
// #691: the Scope page is its configured state and its observations. The last
// recompute is an auxiliary read: failing leaves its own part out, never the
// page. (The chain length was the other one; the record-integrity card that
// showed it is gone, and test/targets-list-first.test.tsx pins that it is not read.)

import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ScopeStatus } from '../src/renderer/src/components/ScopeStatus'

const obs = { id: 'v1', target: 'v1.example', command: 'curl v1.example', timestamp: 1_700_000_000_000, distance: 'excluded', judged: 'live', cleared: false }

function install(over: { recompute?: () => Promise<unknown>; observations?: () => Promise<unknown> } = {}): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    scope: {
      getObservations: over.observations ?? (async () => ({ rows: [obs], truncated: false })),
      getObservationCount: async () => 1,
      isConfigured: async () => true,
      getLastRecompute: over.recompute ?? (async () => null)
    },
    events: { onNewBatch: () => () => {} }
  }
}
const mount = (): void => { render(<I18nProvider><ScopeStatus /></I18nProvider>) }

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear() })

it('lists the observations when the last recompute cannot be read, with no banner', async () => {
  install({ recompute: async () => { throw new Error('nope') } })
  mount()
  expect(await screen.findByText('v1.example')).toBeTruthy()
  expect(screen.queryByTestId('scope-recomputed-banner')).toBeNull()
})

it('still fails as a page when the observations themselves cannot be read', async () => {
  install({ observations: async () => { throw new Error('db') } })
  mount()
  expect(await screen.findByText('Scope could not be loaded.')).toBeTruthy()
})
