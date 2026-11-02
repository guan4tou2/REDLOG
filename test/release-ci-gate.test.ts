import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM script, also run directly by the Release workflow
import { decideReleaseGate, verifyRelease } from '../scripts/verify-release-ci.mjs'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

type Run = Record<string, unknown>
function run(over: Run = {}): Run {
  return {
    id: 100, run_number: 10, run_attempt: 1, event: 'push', head_branch: 'main', head_sha: SHA,
    status: 'completed', conclusion: 'success', created_at: '2026-11-01T10:00:00Z',
    html_url: 'https://github.com/o/r/actions/runs/100', ...over
  }
}
const decide = (runs: Run[], onMain = true) => decideReleaseGate({ sha: SHA, onMain, runs })

describe('release gate: decision over the CI runs of the tagged commit', () => {
  it('passes when the latest CI push run for the sha succeeded', () => {
    const d = decide([run()])
    expect(d.ok).toBe(true)
    expect(d.state).toBe('success')
  })

  it('fails with no run at all, naming the sha', () => {
    const d = decide([])
    expect(d.ok).toBe(false)
    expect(d.state).toBe('no-run')
    expect(d.message).toContain(SHA)
  })

  it('fails when the only successful run belongs to a different sha', () => {
    const d = decide([run({ head_sha: OTHER })])
    expect(d.ok).toBe(false)
    expect(d.state).toBe('no-run')
    expect(d.message).toContain(SHA)
    expect(d.message).toContain(OTHER.slice(0, 12))
  })

  it('does not count a pull_request run of the sha as the push run', () => {
    const d = decide([run({ event: 'pull_request' })])
    expect(d.ok).toBe(false)
    expect(d.state).toBe('no-run')
  })

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])(
    'fails a %s run with a wait-and-re-run message, never a pass', (status) => {
      const d = decide([run({ status, conclusion: null })])
      expect(d.ok).toBe(false)
      expect(d.state).toBe('in-progress')
      expect(d.message).toMatch(/wait/i)
      expect(d.message).toMatch(/re-run/i)
    })

  it('fails a failed run and says so', () => {
    const d = decide([run({ conclusion: 'failure' })])
    expect(d.ok).toBe(false)
    expect(d.state).toBe('failed')
    expect(d.message).toContain('failure')
    expect(d.message).toContain(SHA)
  })

  it('fails a cancelled run: cancelled is not success', () => {
    const d = decide([run({ conclusion: 'cancelled' })])
    expect(d.ok).toBe(false)
    expect(d.state).toBe('failed')
    expect(d.message).toContain('cancelled')
  })

  it.each(['skipped', 'timed_out', 'neutral', 'action_required', 'startup_failure', 'stale'])(
    'treats conclusion %s as not green', (conclusion) => {
      expect(decide([run({ conclusion })]).ok).toBe(false)
    })

  it('uses the latest run: an earlier success does not rescue a later failure', () => {
    const d = decide([
      run({ id: 1, created_at: '2026-11-01T10:00:00Z', conclusion: 'success' }),
      run({ id: 2, created_at: '2026-11-01T11:00:00Z', conclusion: 'failure' })
    ])
    expect(d.ok).toBe(false)
    expect(d.state).toBe('failed')
  })

  it('uses the latest run: a later success replaces an earlier failure', () => {
    const d = decide([
      run({ id: 2, created_at: '2026-11-01T11:00:00Z', conclusion: 'success' }),
      run({ id: 1, created_at: '2026-11-01T10:00:00Z', conclusion: 'failure' })
    ])
    expect(d.ok).toBe(true)
  })

  it('a later run that is still going outranks an earlier success', () => {
    const d = decide([
      run({ id: 1, created_at: '2026-11-01T10:00:00Z' }),
      run({ id: 2, created_at: '2026-11-01T11:00:00Z', status: 'in_progress', conclusion: null })
    ])
    expect(d.ok).toBe(false)
    expect(d.state).toBe('in-progress')
  })

  it('breaks a created_at tie by run id', () => {
    const d = decide([
      run({ id: 7, conclusion: 'failure' }),
      run({ id: 8, conclusion: 'success' })
    ])
    expect(d.ok).toBe(true)
  })

  it('fails a commit that is not on main even when its CI run is green', () => {
    const d = decide([run()], false)
    expect(d.ok).toBe(false)
    expect(d.state).toBe('not-on-main')
    expect(d.message).toContain(SHA)
    expect(d.message).toContain('main')
  })
})

describe('release gate: resolving the tag and reading the repository', () => {
  const io = (over: Record<string, unknown> = {}) => ({
    resolveTag: () => SHA,
    isShallow: () => false,
    isAncestorOfMain: () => true,
    listCiRuns: () => [run()],
    ...over
  })

  it('passes for a tag on main whose CI run succeeded, and asks CI for exactly that sha', () => {
    let asked: string | undefined
    const d = verifyRelease('v1.2.3', io({ listCiRuns: (s: string) => { asked = s; return [run()] } }))
    expect(d.ok).toBe(true)
    expect(asked).toBe(SHA)
  })

  it('refuses a tag that does not look like a version tag', () => {
    expect(verifyRelease('main', io()).ok).toBe(false)
    expect(verifyRelease('', io()).ok).toBe(false)
    expect(verifyRelease('v1; rm -rf /', io()).ok).toBe(false)
  })

  it('refuses a tag that does not exist', () => {
    const d = verifyRelease('v9.9.9', io({ resolveTag: () => null }))
    expect(d.ok).toBe(false)
    expect(d.message).toContain('v9.9.9')
  })

  it('refuses to judge ancestry from a shallow clone', () => {
    const d = verifyRelease('v1.2.3', io({ isShallow: () => true }))
    expect(d.ok).toBe(false)
    expect(d.message).toMatch(/shallow/i)
  })

  it('does not call the API when the commit is not on main', () => {
    let called = false
    const d = verifyRelease('v1.2.3', io({ isAncestorOfMain: () => false, listCiRuns: () => { called = true; return [] } }))
    expect(d.ok).toBe(false)
    expect(d.state).toBe('not-on-main')
    expect(called).toBe(false)
  })
})
