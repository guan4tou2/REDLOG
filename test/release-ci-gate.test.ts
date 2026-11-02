import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — plain ESM script, also run directly by the Release workflow
import { decideReleaseGate, verifyRelease, resolveTagCommit } from '../scripts/verify-release-ci.mjs'

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
    headSha: () => SHA,
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

describe('release gate: the tag is resolved once, to a commit, from refs/tags only', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let dir: string
  let a: string
  let b: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'redlog-release-tag-'))
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'a')
    a = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'b')
    b = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'tag', 'v1.0.0', a) // lightweight
    git(dir, 'tag', '-a', 'v1.1.0', '-m', 'annotated', a) // annotated: the tag object differs from the commit
    git(dir, 'branch', 'v2.0.0', b) // a branch named like a tag...
    git(dir, 'tag', 'v2.0.0', a) // ...beside the tag itself
    git(dir, 'branch', 'v3.0.0', b) // a branch with no tag at all
    writeFileSync(join(dir, 'f'), 'x')
    const blob = git(dir, 'hash-object', '-w', 'f')
    git(dir, 'tag', 'v4.0.0', blob) // a tag that is not a commit
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('resolves a lightweight tag to its commit', () => {
    expect(resolveTagCommit('v1.0.0', dir)).toBe(a)
  })
  it('peels an annotated tag to the commit, not the tag object', () => {
    const tagObject = git(dir, 'rev-parse', 'refs/tags/v1.1.0')
    expect(tagObject).not.toBe(a)
    expect(resolveTagCommit('v1.1.0', dir)).toBe(a)
  })
  it('returns null for a tag that does not exist', () => {
    expect(resolveTagCommit('v9.9.9', dir)).toBeNull()
  })
  it('takes the tag, not a branch of the same name', () => {
    expect(b).not.toBe(a)
    expect(resolveTagCommit('v2.0.0', dir)).toBe(a)
  })
  it('does not fall back to a branch when there is no such tag', () => {
    expect(resolveTagCommit('v3.0.0', dir)).toBeNull()
  })
  it('returns null for a tag that does not point at a commit', () => {
    expect(resolveTagCommit('v4.0.0', dir)).toBeNull()
  })

  it('verifyRelease fails when the checked-out HEAD is not the resolved commit', () => {
    const d = verifyRelease('v1.2.3', {
      resolveTag: () => SHA, headSha: () => OTHER, isShallow: () => false,
      isAncestorOfMain: () => true, listCiRuns: () => [run()]
    })
    expect(d.ok).toBe(false)
    expect(d.state).toBe('checkout-mismatch')
    expect(d.message).toContain(SHA)
  })
  it('verifyRelease reports the resolved sha so the workflow can build exactly it', () => {
    const d = verifyRelease('v1.2.3', {
      resolveTag: () => SHA, headSha: () => SHA, isShallow: () => false,
      isAncestorOfMain: () => true, listCiRuns: () => [run()]
    })
    expect(d.ok).toBe(true)
    expect(d.sha).toBe(SHA)
  })
})
