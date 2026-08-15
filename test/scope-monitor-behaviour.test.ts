// Behavioural coverage for the REAL ScopeMonitor + classifyTarget.
//
// `scope-monitor.test.ts` re-implements the matching logic inline, so it proves
// the algorithm is sound but never touches the shipped class — which means the
// one option that decides whether an operator is warned at all,
// `scope.alertFloor`, had no coverage. This file drives the class itself.
//
// No operatorId is configured anywhere below: `recordViolation` short-circuits
// before `insertEvent` without one, so the violation bookkeeping is exercised
// without needing a DB.

import { describe, it, expect, beforeEach } from 'vitest'
import { ScopeMonitor, classifyTarget, classifyDistance } from '../src/core/scope-monitor'

// `*.app.example.com`, not `*.example.com`: a wildcard covers every host under
// it, so a scope of `*.example.com` would leave no same-root-but-out-of-scope
// host to test the "warn only on neighbours" rule with. `vpn.example.com` is
// that host here — same root domain (example.com), outside the scope.
const SCOPE = ['10.0.0.0/24', '*.app.example.com']
const EXCLUDED = ['10.0.0.1', 'dc01.app.example.com']

describe('classifyTarget — the four verdicts', () => {
  const cfg = { targets: SCOPE, excludeTargets: EXCLUDED }

  const cases: Array<[string, string | null | undefined, typeof cfg, string]> = [
    ['no target at all → unknown (caller picks the safe default)', null, cfg, 'unknown'],
    ['empty string → unknown', '', cfg, 'unknown'],
    ['undefined → unknown', undefined, cfg, 'unknown'],
    ['no scope configured → everything is in scope', 'anything.test', { targets: [], excludeTargets: [] }, 'in_scope'],
    ['IP inside the CIDR → in_scope', '10.0.0.9', cfg, 'in_scope'],
    ['IP outside the CIDR → out_of_scope', '10.0.1.9', cfg, 'out_of_scope'],
    ['wildcard subdomain hit → in_scope', 'api.app.example.com', cfg, 'in_scope'],
    ['wildcard also covers the bare domain it is anchored on', 'app.example.com', cfg, 'in_scope'],
    ['same root but outside the wildcard → out_of_scope', 'vpn.example.com', cfg, 'out_of_scope'],
    ['unrelated domain → out_of_scope', 'google.com', cfg, 'out_of_scope'],
    ['excluded IP beats the enclosing CIDR', '10.0.0.1', cfg, 'excluded'],
    ['excluded host beats the wildcard', 'dc01.app.example.com', cfg, 'excluded']
  ]

  for (const [name, target, config, expected] of cases) {
    it(name, () => {
      expect(classifyTarget(target, config)).toBe(expected)
    })
  }

  it('an exclude entry alone does not put an unrelated host in scope', () => {
    expect(classifyTarget('other.test', { targets: SCOPE, excludeTargets: ['other.test'] })).toBe('excluded')
  })
})

describe('ScopeMonitor.checkTarget — alertFloor: adjacent (default)', () => {
  let m: ScopeMonitor

  beforeEach(() => {
    m = new ScopeMonitor()
    m.configure({ targets: SCOPE, excludeTargets: EXCLUDED, alertFloor: 'adjacent' })
  })

  it('in-scope target: in scope, no violation, nothing recorded', () => {
    expect(m.checkTarget('10.0.0.9', 'nmap 10.0.0.9')).toEqual({ inScope: true, violation: false })
    expect(m.getViolationCount()).toBe(0)
  })

  it('same-root out-of-scope host raises a violation', () => {
    expect(m.checkTarget('vpn.example.com', 'curl vpn.example.com')).toEqual({ inScope: false, violation: true })
    expect(m.getViolationCount()).toBe(1)
  })

  // Pre-G-B3 this raised: the IP branch skipped the proximity filter entirely,
  // so every out-of-scope IP alerted as loudly as hitting the wrong box on the
  // target segment. SCOPE's only IP entry is a CIDR (10.0.0.0/24), which states
  // its own boundary and is never widened — so 192.168.50.1 is D3, not D2.
  it('an out-of-scope IP outside every container is D3: out of scope, no violation', () => {
    expect(m.checkTarget('192.168.50.1', 'nmap 192.168.50.1')).toEqual({ inScope: false, violation: false })
    expect(m.getViolationCount()).toBe(0)
    expect(m.getUnrelatedCount()).toBe(1)
  })

  it('an unrelated domain is out of scope but NOT a violation — no alert fatigue', () => {
    expect(m.checkTarget('google.com', 'curl google.com')).toEqual({ inScope: false, violation: false })
    expect(m.getViolationCount()).toBe(0)
  })

  it('an excluded target raises a violation even though it sits inside the scope', () => {
    expect(m.checkTarget('dc01.app.example.com', 'nmap dc01.app.example.com').violation).toBe(true)
  })

  it('records target, command and a timestamp for each violation', () => {
    const before = Date.now()
    m.checkTarget('vpn.example.com', 'curl -s https://vpn.example.com/login')
    const [v] = m.getViolations()
    expect(v.target).toBe('vpn.example.com')
    expect(v.command).toBe('curl -s https://vpn.example.com/login')
    expect(v.timestamp).toBeGreaterThanOrEqual(before)
  })

  it('accumulates repeat violations rather than deduping them', () => {
    m.checkTarget('vpn.example.com', 'curl vpn.example.com')
    m.checkTarget('vpn.example.com', 'curl vpn.example.com')
    expect(m.getViolationCount()).toBe(2)
  })

  it('getViolations hands back a copy — callers cannot mutate the record', () => {
    m.checkTarget('vpn.example.com', 'curl vpn.example.com')
    m.getViolations().push({ target: 'forged', command: 'x', timestamp: 0 })
    expect(m.getViolationCount()).toBe(1)
  })
})

describe('ScopeMonitor.checkTarget — alertFloor: excluded_only', () => {
  let m: ScopeMonitor

  beforeEach(() => {
    m = new ScopeMonitor()
    m.configure({ targets: SCOPE, excludeTargets: EXCLUDED, alertFloor: 'excluded_only' })
  })

  it('a same-root out-of-scope host is silent: still out of scope, no violation', () => {
    expect(m.checkTarget('vpn.example.com', 'curl vpn.example.com')).toEqual({ inScope: false, violation: false })
    expect(m.getViolationCount()).toBe(0)
  })

  it('an out-of-scope IP is silent too', () => {
    expect(m.checkTarget('192.168.50.1', 'nmap 192.168.50.1').violation).toBe(false)
  })

  it('silences an adjacent subnet as well — D2 is inferred, so it is silenceable', () => {
    const q = new ScopeMonitor()
    q.configure({ targets: ['192.168.1.10'], alertFloor: 'excluded_only' })
    expect(q.checkTarget('192.168.1.55', 'nmap 192.168.1.55').violation).toBe(false)
  })

  it('an EXCLUDED target still warns — "keep off X" is not a preference call', () => {
    expect(m.checkTarget('dc01.app.example.com', 'nmap dc01.app.example.com').violation).toBe(true)
    expect(m.getViolationCount()).toBe(1)
  })

  it('in-scope traffic is unaffected', () => {
    expect(m.checkTarget('10.0.0.9', 'nmap 10.0.0.9').inScope).toBe(true)
  })
})

describe('ScopeMonitor.configure — which fields a partial update touches', () => {
  it('an empty scope list means "no scope set": everything passes, nothing is recorded', () => {
    const m = new ScopeMonitor()
    m.configure({ targets: [], excludeTargets: [] })
    expect(m.checkTarget('anything.test', 'curl anything.test')).toEqual({ inScope: true, violation: false })
    expect(m.isConfigured()).toBe(false)
  })

  it('isConfigured flips once targets are set', () => {
    const m = new ScopeMonitor()
    expect(m.isConfigured()).toBe(false)
    m.configure({ targets: SCOPE })
    expect(m.isConfigured()).toBe(true)
  })

  it('the floor defaults to adjacent when the caller omits it', () => {
    const m = new ScopeMonitor()
    m.configure({ targets: SCOPE })
    expect(m.checkTarget('vpn.example.com', 'curl vpn.example.com').violation).toBe(true)
  })

  it('omitting alertFloor on a later call keeps the value already set', () => {
    const m = new ScopeMonitor()
    m.configure({ targets: SCOPE, alertFloor: 'excluded_only' })
    m.configure({ targets: SCOPE, excludeTargets: [] })   // no alertFloor key
    expect(m.checkTarget('vpn.example.com', 'curl vpn.example.com').violation).toBe(false)
  })

  it('re-configuring the target list re-derives the root domains used for warnings', () => {
    const m = new ScopeMonitor()
    m.configure({ targets: ['*.app.example.com'] })
    expect(m.checkTarget('vpn.example.com', 'curl vpn.example.com').violation).toBe(true)
    m.configure({ targets: ['*.app.other.com'] })
    // example.com is no longer a known root, so the same host goes quiet.
    expect(m.checkTarget('vpn.example.com', 'curl vpn.example.com').violation).toBe(false)
    expect(m.checkTarget('vpn.other.com', 'curl vpn.other.com').violation).toBe(true)
  })

  it('keeps the full command in memory — only the chained event slices it to 200 chars', () => {
    const m = new ScopeMonitor()
    m.configure({ targets: SCOPE })
    const long = 'curl ' + 'a'.repeat(400)
    m.checkTarget('vpn.example.com', long)
    expect(m.getViolations()[0].command).toBe(long)
  })
})

// The distance ladder (`docs/ALERT-ROLES.md` Part B). D1 > D0 > D2 > D3.
describe('classifyDistance — the ladder', () => {
  // A single-IP entry carries no boundary, so it expands to its /24 container.
  // A CIDR entry states one, so it does not expand.
  const cfg = {
    targets: ['192.168.1.10', '10.0.0.0/24', 'www.example.com', '*.app.example.com'],
    excludeTargets: ['192.168.1.99', 'dc01.app.example.com']
  }

  const cases: Array<[string, string, string]> = [
    ['D0  single-IP entry, exact hit          ', '192.168.1.10', 'in_scope'],
    ['D0  inside the stated CIDR              ', '10.0.0.9', 'in_scope'],
    ['D0  exact host entry                    ', 'www.example.com', 'in_scope'],
    ['D0  under the wildcard                  ', 'api.app.example.com', 'in_scope'],
    ['D1  excluded IP beats its container     ', '192.168.1.99', 'excluded'],
    ['D1  excluded host beats the wildcard    ', 'dc01.app.example.com', 'excluded'],
    ['D2  same subnet as a single-IP entry    ', '192.168.1.55', 'adjacent_subnet'],
    ['D2  same registrable domain             ', 'admin.example.com', 'adjacent_domain'],
    ['D3  outside a stated CIDR is NOT near   ', '10.0.1.9', 'unrelated'],
    ['D3  unrelated subnet                    ', '172.16.4.4', 'unrelated'],
    ['D3  unrelated domain                    ', 'google.com', 'unrelated'],
    ['D3  public resolver during recon        ', '8.8.8.8', 'unrelated']
  ]

  for (const [name, target, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyDistance(target, cfg)).toBe(expected)
    })
  }

  it('no scope configured means everything is in scope', () => {
    expect(classifyDistance('anything.test', { targets: [], excludeTargets: [] })).toBe('in_scope')
  })

  // G-B1: the requested "same subnet, wrong host" alert.
  it('G-B1: enumerated hosts make their segment adjacent — the wrong-box case', () => {
    const enumerated = { targets: ['192.168.1.10', '192.168.1.20'], excludeTargets: [] }
    expect(classifyDistance('192.168.1.55', enumerated)).toBe('adjacent_subnet')
    expect(classifyDistance('192.168.2.55', enumerated)).toBe('unrelated')
  })

  // G-B3: the noise that got the channel muted.
  it('G-B3: a stated CIDR is not widened — its complement is unrelated, not adjacent', () => {
    const stated = { targets: ['192.168.1.0/24'], excludeTargets: [] }
    expect(classifyDistance('192.168.2.55', stated)).toBe('unrelated')
    expect(classifyDistance('8.8.8.8', stated)).toBe('unrelated')
  })

  it('proximityBits widens or narrows the container for single-IP entries only', () => {
    const t = { targets: ['192.168.1.10', '10.0.0.0/24'], excludeTargets: [] }
    expect(classifyDistance('192.168.2.55', { ...t, proximityBits: 16 })).toBe('adjacent_subnet')
    expect(classifyDistance('192.168.2.55', { ...t, proximityBits: 24 })).toBe('unrelated')
    // The CIDR entry is untouched by the knob at any width.
    expect(classifyDistance('10.0.1.9', { ...t, proximityBits: 16 })).toBe('unrelated')
  })

  it('a nonsensical proximityBits falls back to the default rather than opening up', () => {
    const t = { targets: ['192.168.1.10'], excludeTargets: [] }
    for (const bits of [0, -1, 33, 1.5, NaN]) {
      expect(classifyDistance('192.168.2.55', { ...t, proximityBits: bits })).toBe('unrelated')
      expect(classifyDistance('192.168.1.55', { ...t, proximityBits: bits })).toBe('adjacent_subnet')
    }
  })

  // The deliberate asymmetry: a wildcard still expands to its registrable
  // domain, because that domain is the ownership boundary the authorisation is
  // about. Scoped to staging, hitting prod is exactly what D2 exists to catch.
  it('a wildcard entry still makes its registrable domain adjacent', () => {
    const staging = { targets: ['*.staging.example.com'], excludeTargets: [] }
    expect(classifyDistance('prod.example.com', staging)).toBe('adjacent_domain')
    expect(classifyDistance('google.com', staging)).toBe('unrelated')
  })
})

describe('ScopeMonitor — D2 subnet adjacency end-to-end', () => {
  let m: ScopeMonitor

  beforeEach(() => {
    m = new ScopeMonitor()
    m.configure({ targets: ['192.168.1.10', '192.168.1.20'], excludeTargets: [], alertFloor: 'adjacent' })
  })

  it('warns on the wrong box in the right segment', () => {
    expect(m.checkTarget('192.168.1.55', 'nmap 192.168.1.55')).toEqual({ inScope: false, violation: true })
    expect(m.getViolationCount()).toBe(1)
  })

  it('stays quiet on an unrelated host and counts it instead of dropping it', () => {
    expect(m.checkTarget('8.8.8.8', 'dig @8.8.8.8 example.com').violation).toBe(false)
    expect(m.getViolationCount()).toBe(0)
    expect(m.getUnrelatedCount()).toBe(1)
  })

  it('re-configuring proximityBits takes effect on the next check', () => {
    expect(m.checkTarget('192.168.9.55', 'nmap 192.168.9.55').violation).toBe(false)
    m.configure({ proximityBits: 16 })
    expect(m.checkTarget('192.168.9.55', 'nmap 192.168.9.55').violation).toBe(true)
  })
})

// G-B2: the registrable-domain rule that decides D2 `adjacent_domain`.
describe('classifyDistance — registrable domain, not last-two-labels', () => {
  it('a multi-label ccTLD no longer drags in the whole suffix', () => {
    // Narrow wildcard for the same reason SCOPE uses `*.app.example.com`: a
    // wildcard covers everything under it, leaving no same-domain host outside.
    const cfg = { targets: ['*.app.example.co.uk'], excludeTargets: [] }
    // Pre-G-B2 the scope root was `co.uk`, so BOTH of these were adjacent.
    expect(classifyDistance('vpn.example.co.uk', cfg)).toBe('adjacent_domain')
    expect(classifyDistance('www.bbc.co.uk', cfg)).toBe('unrelated')
    expect(classifyDistance('shop.other.com.tw', { targets: ['*.corp.com.tw'], excludeTargets: [] }))
      .toBe('unrelated')
  })

  it('a platform suffix no longer makes every tenant a neighbour', () => {
    const cfg = { targets: ['target.github.io'], excludeTargets: [] }
    expect(classifyDistance('someone-else.github.io', cfg)).toBe('unrelated')
    expect(classifyDistance('docs.target.github.io', cfg)).toBe('adjacent_domain')
  })

  it('bucket neighbours on s3 are not adjacent to each other', () => {
    const cfg = { targets: ['client-assets.s3.amazonaws.com'], excludeTargets: [] }
    expect(classifyDistance('someone-elses-bucket.s3.amazonaws.com', cfg)).toBe('unrelated')
  })

  it('ordinary domains are unchanged — the common case did not regress', () => {
    const cfg = { targets: ['*.app.example.com'], excludeTargets: [] }
    expect(classifyDistance('vpn.example.com', cfg)).toBe('adjacent_domain')
    expect(classifyDistance('google.com', cfg)).toBe('unrelated')
  })

  it('publicSuffixes lets an operator teach it a suffix per engagement', () => {
    const cfg = { targets: ['*.a.corp.internal'], excludeTargets: [] }
    expect(classifyDistance('b.corp.internal', cfg)).toBe('adjacent_domain')
    expect(classifyDistance('b.corp.internal', { ...cfg, publicSuffixes: ['corp.internal'] }))
      .toBe('unrelated')
  })
})

describe('ScopeMonitor — publicSuffixes wiring', () => {
  it('configure rebuilds the suffix set and the next check uses it', () => {
    const m = new ScopeMonitor()
    m.configure({ targets: ['*.a.corp.internal'], alertFloor: 'adjacent' })
    expect(m.checkTarget('b.corp.internal', 'curl b.corp.internal').violation).toBe(true)
    m.configure({ publicSuffixes: ['corp.internal'] })
    expect(m.checkTarget('b.corp.internal', 'curl b.corp.internal').violation).toBe(false)
  })
})

// G-A5's twin on the scope side: `IP_RE` matched only dotted quads, so a v6
// target was routed through the DOMAIN matcher. A v6 CIDR scope entry never
// matched, and on the adjacency path a v6 host fell out as `unrelated` —
// silent, which is the one direction this subsystem must not fail in.
describe('classifyDistance over IPv6', () => {
  const cfg = {
    targets: ['2001:db8:0:1::/64', '2001:db8:0:9::10'],
    excludeTargets: ['2001:db8:0:1::99']
  }

  const cases: Array<[string, string, string]> = [
    ['D0  inside the stated v6 CIDR        ', '2001:db8:0:1::5', 'in_scope'],
    ['D0  the exact single-address entry   ', '2001:db8:0:9::10', 'in_scope'],
    ['D0  an equivalent notation of it     ', '2001:0db8:0000:0009:0000:0000:0000:0010', 'in_scope'],
    ['D1  excluded beats its CIDR          ', '2001:db8:0:1::99', 'excluded'],
    ['D2  same /64 as a single-IP entry    ', '2001:db8:0:9::ff', 'adjacent_subnet'],
    ['D3  outside a stated CIDR            ', '2001:db8:0:2::5', 'unrelated'],
    ['D3  a different /32 entirely         ', '2001:dead::1', 'unrelated']
  ]

  for (const [name, target, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyDistance(target, cfg)).toBe(expected)
    })
  }

  it('a v6 target is no longer mistaken for a hostname', () => {
    // Pre-fix this reached the domain matcher, so nothing but a byte-identical
    // string could match and the adjacency path went silent.
    expect(classifyDistance('2001:db8:0:1::5', cfg)).not.toBe('unrelated')
  })

  // v6 subnets are /64 by convention, so a single-IP v6 entry expands to its
  // /64 rather than to `proximityBits` (which is a v4 answer).
  it('a single-IP v6 entry expands to its /64, not to proximityBits', () => {
    const single = { targets: ['2001:db8:0:9::10'], excludeTargets: [] }
    expect(classifyDistance('2001:db8:0:9::ff', single)).toBe('adjacent_subnet')
    expect(classifyDistance('2001:db8:0:a::ff', single)).toBe('unrelated')
    // The v4 knob does not reach across families.
    expect(classifyDistance('2001:db8:0:a::ff', { ...single, proximityBits: 8 })).toBe('unrelated')
  })

  it('families do not cross', () => {
    expect(classifyDistance('10.8.0.5', cfg)).toBe('unrelated')
    expect(classifyDistance('2001:db8:0:1::5', { targets: ['10.0.0.0/8'], excludeTargets: [] })).toBe('unrelated')
  })
})

describe('classifyTarget over IPv6 — sanitize and alerting must agree', () => {
  const cfg = { targets: ['2001:db8:0:1::/64'], excludeTargets: ['2001:db8:0:1::99'] }

  it('an in-scope v6 host is in_scope for the sanitize path too', () => {
    expect(classifyTarget('2001:db8:0:1::5', cfg)).toBe('in_scope')
  })

  it('an excluded v6 host is excluded', () => {
    expect(classifyTarget('2001:db8:0:1::99', cfg)).toBe('excluded')
  })

  it('an out-of-scope v6 host is out_of_scope', () => {
    expect(classifyTarget('2001:db8:0:2::5', cfg)).toBe('out_of_scope')
  })
})

// G-C3. The ladder is ORDERED, so the control is a floor rather than N
// booleans — those would let an operator construct incoherent states ("warn on
// unrelated but not on adjacent"). D1 is present at every position by
// construction, which makes the fact-tier rule structural instead of something
// each caller has to remember.
describe('alertFloor — the three positions', () => {
  const CFG = { targets: ['192.168.1.10', '*.app.example.com'], excludeTargets: ['dc01.app.example.com'] }
  const at = (alertFloor: 'excluded_only' | 'adjacent' | 'all'): ScopeMonitor => {
    const m = new ScopeMonitor()
    m.configure({ ...CFG, alertFloor })
    return m
  }

  const D1 = ['dc01.app.example.com', 'nmap dc01.app.example.com'] as const
  const D2 = ['192.168.1.55', 'nmap 192.168.1.55'] as const
  const D3 = ['8.8.8.8', 'dig @8.8.8.8 example.com'] as const

  it('excluded_only: D1 alone', () => {
    const m = at('excluded_only')
    expect(m.checkTarget(...D1).violation).toBe(true)
    expect(m.checkTarget(...D2).violation).toBe(false)
    expect(m.checkTarget(...D3).violation).toBe(false)
  })

  it('adjacent (default): D1 + D2', () => {
    const m = at('adjacent')
    expect(m.checkTarget(...D1).violation).toBe(true)
    expect(m.checkTarget(...D2).violation).toBe(true)
    expect(m.checkTarget(...D3).violation).toBe(false)
  })

  it('all: D1 + D2 + D3 — the strict-authorisation position', () => {
    const m = at('all')
    expect(m.checkTarget(...D1).violation).toBe(true)
    expect(m.checkTarget(...D2).violation).toBe(true)
    expect(m.checkTarget(...D3).violation).toBe(true)
  })

  // The whole reason it is a floor and not three checkboxes.
  it('there is no position that silences D1', () => {
    for (const floor of ['excluded_only', 'adjacent', 'all'] as const) {
      expect(at(floor).checkTarget(...D1).violation).toBe(true)
    }
  })

  it('a D3 emission is fact tier — a non-match has no proximity heuristic in it', () => {
    const m = at('all')
    m.checkTarget(...D3)
    const [v] = m.getViolations()
    expect(v.reason).toBe('unrelated')
    expect(v.authority).toBe('fact')
  })

  // The count is kept at every floor: "silent" must stay distinguishable from
  // "not looking", and the adherence report (G-D1) needs the denominator.
  it('D3 is counted at every floor, emitted at only one', () => {
    for (const floor of ['excluded_only', 'adjacent', 'all'] as const) {
      const m = at(floor)
      m.checkTarget(...D3)
      expect(m.getUnrelatedCount()).toBe(1)
      expect(m.getViolationCount()).toBe(floor === 'all' ? 1 : 0)
    }
  })

  it('in-scope traffic is untouched at every floor', () => {
    for (const floor of ['excluded_only', 'adjacent', 'all'] as const) {
      expect(at(floor).checkTarget('192.168.1.10', 'nmap 192.168.1.10')).toEqual({ inScope: true, violation: false })
    }
  })
})
