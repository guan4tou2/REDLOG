import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { isExternalEventAllowed, isKindAllowed } from '../src/core/external-event-policy'

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

// Spec 071 T010: the kind policy has a `legacy` row, but POST /api/events does
// not ask it — the route keeps its own two checks, because it answers them with
// two different 403s. This holds the two to one policy: both checks are lifted
// out of src/core/api-server.ts with the TypeScript parser and run beside
// `isKindAllowed('legacy', …)` over the same pairs. When the route asks the
// table itself, this test goes.
describe('the `legacy` row is the policy POST /api/events applies', () => {
  const file = path.join(__dirname, '..', 'src', 'core', 'api-server.ts')
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
  const conditions: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && /\bjson\(res, 403\b/.test(node.thenStatement.getText(sf))) conditions.push(node.expression.getText(sf))
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // Each check as the route writes it, outside the E2E seed door.
  const lift = (needle: string, params: string): ((agentType: string, data: unknown) => boolean) => {
    const found = conditions.filter((c) => c.includes(needle))
    expect(found, `api-server.ts: one 403 check naming ${needle}`).toHaveLength(1)
    const js = ts.transpileModule(`return (${found[0]})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    return new Function('e2eSeed', 'isExternalEventAllowed', ...params.split(','), js).bind(null, false, isExternalEventAllowed) as (agentType: string, data: unknown) => boolean
  }

  it('accepts and refuses the same (agent_type, data) pairs as the route', () => {
    const refusedType = lift('isExternalEventAllowed(', 'agentType,body')
    const refusedAmendment = lift(`'amended'`, 'agentType,data')
    // The route's admission, for a body whose data is an object (anything else
    // is a 400 before the second check, not a policy answer).
    const route = (agentType: string, data: unknown): boolean =>
      !refusedType(agentType, { data }) && !refusedAmendment(agentType, data ?? {})
    // EXTERNAL_ALLOWED_AGENT_TYPES, the derived types its comment names, the
    // route's default `external`, and one unknown type.
    const types = ['scanner', 'shell', 'terminal', 'dns', 'external', 'agent', 'marker', 'process', 'credential_use',
      'file_transfer', 'screenshot', 'browser', 'http_navigation', 'pcap',
      'system', 'pivot', 'cleanup', 'loot', 'scope_violation', 'nonsense']
    const datas: unknown[] = [undefined, null, {}, { subtype: 'note' }, { subtype: 'amended' }, { subtype: 'command_start' },
      { subtype: 'producer_heartbeat', producer: 'pcap-capture' },
      { subtype: 'producer_heartbeat', producer: 'pcap-capture', extra: 'forged' },
      { subtype: 'recording_resumed', source: 'operator' }]
    const disagree: string[] = []
    let accepted = 0
    for (const t of types) {
      for (const d of datas) {
        const table = isKindAllowed('legacy', t, d)
        if (table) accepted++
        if (table !== route(t, d)) disagree.push(`${t} ${JSON.stringify(d)}: table ${table}, route ${!table}`)
      }
    }
    expect(disagree).toEqual([])
    // Neither side is vacuous: both accept and refuse.
    expect(accepted).toBeGreaterThan(0)
    expect(accepted).toBeLessThan(types.length * datas.length)
    expect(isKindAllowed('legacy', 'marker', { subtype: 'amended' })).toBe(false)
    expect(isKindAllowed('legacy', 'system', { subtype: 'producer_heartbeat', producer: 'pcap-capture' })).toBe(true)
  })
})
