import { describe, it, expect } from 'vitest'
import { planInstall } from '../src/core/dependency-install'
import type { PreflightCheck } from '../src/core/runtime-preflight'

// planInstall decides whether RedLog may run a remediation itself. runtime-
// preflight already produced the command and flagged a missing installer; this
// only classifies it — run / needs-prereq / manual / none — so the main-process
// spawner never has to.
const check = (over: Partial<PreflightCheck>): PreflightCheck => ({
  id: 'mitmdump', found: false, neededFor: ['mitmproxy'], ...over
})

describe('planInstall', () => {
  it('runs an unprivileged remediation once its installer is present', () => {
    const plan = planInstall(check({ remediation: 'uv tool install mitmproxy' }))
    expect(plan).toEqual({ kind: 'run', command: 'uv', args: ['tool', 'install', 'mitmproxy'] })
  })

  it('asks for the prerequisite instead of ENOENT-ing when uv is missing', () => {
    const prereq = { command: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' }
    const plan = planInstall(check({ remediation: 'uv tool install mitmproxy', remediationRequires: prereq }))
    expect(plan).toEqual({ kind: 'needs-prereq', prereq })
  })

  it('leaves a sudo remediation for the operator to run in a terminal', () => {
    const plan = planInstall(check({ id: 'python3', remediation: 'sudo apt install python3' }))
    expect(plan).toEqual({ kind: 'manual', command: 'sudo apt install python3', reason: 'elevation' })
  })

  it('does nothing when the dependency is already present', () => {
    expect(planInstall(check({ found: true }))).toEqual({ kind: 'none', reason: 'present' })
  })

  it('does nothing when there is no remediation for the platform', () => {
    expect(planInstall(check({ remediation: undefined }))).toEqual({ kind: 'none', reason: 'no-remediation' })
  })
})
