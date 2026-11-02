// Release gate: a tag may only be built if its commit is on main and the CI
// workflow passed on that exact commit. Run first by .github/workflows/release.yml
// (RELEASE_TAG, GITHUB_REPOSITORY and GH_TOKEN in the environment, full clone).
// It is run as `node scripts/verify-release-ci.mjs` and has no shebang: a
// Windows checkout turns the file CRLF, and the unit test that imports it then
// fails to load ("Invalid or unexpected token").
//
// Which run counts: CI runs on every merge to main (`push`, grouped by sha, so
// each commit gets its own). If several push runs exist for the sha, the LATEST
// one decides. A re-run of a run keeps its id and replaces its result, so a
// green re-run of a flaky failure passes. A later, separate run that failed or
// is still going outranks an earlier success: it is the newest evidence about
// this same commit, and anyone who disagrees can re-run it to green.
//
// The tag is resolved here once, from refs/tags/<tag> only (a branch of the same
// name is never consulted), peeled to its commit, and written to GITHUB_OUTPUT
// as `sha`. The build and release jobs check out that sha instead of looking the
// tag up again, so a tag moved after this gate passed is not built unchecked.
// This guards against accidents, not a hostile writer: someone who can push to
// the repository can also edit release.yml on the tagged commit. Tag rulesets
// are what stop that.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CI_WORKFLOW = 'ci.yml'
const TAG = /^v\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/

const short = (sha) => String(sha).slice(0, 12)

// Pure: `runs` is the `workflow_runs` array of the Actions API for the CI workflow.
export function decideReleaseGate({ sha, onMain, runs }) {
  if (!onMain) {
    return { ok: false, state: 'not-on-main', message: `Commit ${sha} is not reachable from origin/main. Releases are cut from main only; merge it first or tag a commit on main.` }
  }
  const mine = (runs ?? []).filter((r) => r.head_sha === sha && r.event === 'push')
  if (mine.length === 0) {
    const others = [...new Set((runs ?? []).map((r) => `${short(r.head_sha)} (${r.event})`))]
    const seen = others.length ? ` Runs returned were for other commits or events: ${others.join(', ')}.` : ''
    return { ok: false, state: 'no-run', message: `No CI push run found for commit ${sha}.${seen} A commit that only had a pull-request run has not been through CI on main; tag the merge commit instead.` }
  }
  const latest = [...mine].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)) || (b.id ?? 0) - (a.id ?? 0))[0]
  const where = latest.html_url ? ` ${latest.html_url}` : ''
  if (latest.status !== 'completed') {
    return { ok: false, state: 'in-progress', message: `CI for commit ${sha} is still ${latest.status}.${where} Wait for it to finish, then re-run this release workflow.` }
  }
  if (latest.conclusion !== 'success') {
    return { ok: false, state: 'failed', message: `CI for commit ${sha} concluded ${latest.conclusion}.${where} A release needs a green CI run on the tagged commit.` }
  }
  return { ok: true, state: 'success', message: `CI passed for commit ${sha}.${where}` }
}

// `io` supplies the repository and API reads so the flow is testable offline.
export function verifyRelease(tag, io) {
  if (!TAG.test(tag ?? '')) {
    return { ok: false, state: 'bad-tag', message: `"${tag}" is not a release tag (expected vX.Y.Z).` }
  }
  const sha = io.resolveTag(tag)
  if (!sha) return { ok: false, state: 'bad-tag', message: `Tag refs/tags/${tag} does not exist in this clone or does not point at a commit.` }
  const head = io.headSha()
  if (head !== sha) {
    return { ok: false, state: 'checkout-mismatch', message: `Tag ${tag} resolves to ${sha} but the checkout is at ${head}. The tag moved after checkout, or the wrong ref was checked out.` }
  }
  if (io.isShallow()) {
    return { ok: false, state: 'shallow', message: 'This clone is shallow, so reachability from main cannot be judged. Check out with fetch-depth: 0.' }
  }
  const onMain = io.isAncestorOfMain(sha)
  const decision = onMain
    ? decideReleaseGate({ sha, onMain, runs: io.listCiRuns(sha) })
    : decideReleaseGate({ sha, onMain, runs: [] })
  return { ...decision, sha }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// The commit a release tag points at: refs/tags/<tag> only, annotated tags
// peeled to their commit. null if there is no such tag or it is not a commit.
export function resolveTagCommit(tag, cwd) {
  try { return git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], cwd) || null } catch { return null }
}

function realIo(repo) {
  return {
    resolveTag: (tag) => resolveTagCommit(tag),
    headSha: () => git(['rev-parse', 'HEAD']),
    isShallow: () => git(['rev-parse', '--is-shallow-repository']) === 'true',
    isAncestorOfMain(sha) {
      try { git(['merge-base', '--is-ancestor', sha, 'origin/main']); return true } catch (e) {
        if (e.status === 1) return false // 1 = not an ancestor; anything else is a real error
        throw e
      }
    },
    listCiRuns(sha) {
      const out = execFileSync('gh', [
        'api', `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=push&per_page=100`
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return JSON.parse(out).workflow_runs ?? []
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.env.RELEASE_TAG
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    console.error('GITHUB_REPOSITORY is not set (expected owner/name).')
    process.exit(1)
  }
  let decision
  try {
    decision = verifyRelease(tag, realIo(repo))
  } catch (e) {
    console.error(`Release gate could not read the repository or the Actions API: ${e.stderr ? String(e.stderr).trim() : e.message}`)
    process.exit(1)
  }
  if (!decision.ok) {
    // Workflow commands are read from stdout; locally a plain stderr line is easier to read.
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Release gate (${decision.state})::${decision.message}`)
    else console.error(`Release gate (${decision.state}): ${decision.message}`)
    process.exit(1)
  }
  console.log(`${tag}: ${decision.message}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${decision.sha}\n`)
}
