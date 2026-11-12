import { describe, it, expect } from 'vitest'
import { isExternalEventAllowed } from '../src/core/external-event-policy'

describe('external event policy', () => {
  it('still accepts ordinary external types', () => {
    expect(isExternalEventAllowed('scanner', {})).toBe(true)
    expect(isExternalEventAllowed('pcap', { subtype: 'x' })).toBe(true)
  })

  it('accepts exactly the producer heartbeat under system (what pcap-capture posts)', () => {
    expect(isExternalEventAllowed('system', { subtype: 'producer_heartbeat', producer: 'pcap-capture' })).toBe(true)
  })

  it('refuses every other external system event', () => {
    for (const data of [
      {},
      undefined,
      null,
      'str',
      [],
      { subtype: 'api_started' },
      { subtype: 'session_start' },
      { subtype: 'chain_anchor', producer: 'pcap-capture' },
      { subtype: 'producer_heartbeat' },
      { subtype: 'producer_heartbeat', producer: '' },
      { subtype: 'producer_heartbeat', producer: 7 },
      { subtype: 'producer_heartbeat', producer: "x' OR 1=1" },
      { subtype: 'producer_heartbeat', producer: 'pcap-capture', extra: 'forged' },
      { subtype: 'producer_heartbeat', producer: 'pcap-capture', operator_id: 'x' }
    ]) {
      expect(isExternalEventAllowed('system', data), JSON.stringify(data)).toBe(false)
    }
  })

  it('does not open other derived types', () => {
    for (const t of ['pivot', 'cleanup', 'loot', 'scope_violation', 'nonsense']) {
      expect(isExternalEventAllowed(t, { subtype: 'producer_heartbeat', producer: 'pcap-capture' })).toBe(false)
    }
  })
})
