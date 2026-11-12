#!/usr/bin/env node
// Skip accounting for a CI unit leg (stage 1 of the verification plan).
//
// A skipped test reports green. For as long as nothing counted them, a runner
// image without zsh, a step order that ran Vitest before the build, or a
// native module built for the wrong ABI each turned whole files grey and the
// leg stayed green. This reads the JUnit report Vitest writes in CI and
// compares it with test/skip-baseline.json for this platform:
//
//   - more skipped cases than the baseline, in total or in any one file  → fail
//   - a file with skips that the baseline does not list                  → fail
//   - a "mustRun" file that skipped anything, or is not in the report    → fail
//   - a capability test/capabilities.json marks "required" that the
//     machine lacks (test-results/capabilities-<platform>.json, written by
//     test/helpers/capability-report.ts)                                  → fail
//   - fewer skips than the baseline → a notice: lower the baseline in the
//     same change, so the next regression has less room to hide in
//
// It compares against a file in the repository, not against another ref, so
// it means the same thing on main as on a branch. It cannot see a test that
// was deleted or one that passes without asserting anything; it counts what
// the run said it did not do.
//
// Usage: node scripts/verify-skip-baseline.mjs [junit.xml] [--platform linux|darwin|win32] [--baseline file]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback }
const platform = opt('--platform', process.platform)
const baselineFile = opt('--baseline', path.join(root, 'test/skip-baseline.json'))
const junitFile = args[0] ?? path.join(root, 'test-results/unit-junit.xml')
const gha = !!process.env.GITHUB_ACTIONS

const errors = []
const notices = []
const capNotices = []
const error = (m) => errors.push(m)
const notice = (m) => notices.push(m)

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unescape(m[1]) : undefined }

/** file → { tests, skipped } from Vitest's JUnit report (one <testsuite> per test file). */
function readJunit(xml) {
  const files = new Map()
  for (const m of xml.matchAll(/<testsuite\s[^>]*>/g)) {
    const name = attr(m[0], 'name')
    if (!name) continue
    files.set(name.split('\\').join('/'), { tests: Number(attr(m[0], 'tests') ?? 0), skipped: Number(attr(m[0], 'skipped') ?? 0) })
  }
  return files
}

const baselineAll = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
const baseline = baselineAll[platform]
if (!baseline) {
  console.error(`verify-skip-baseline: no "${platform}" entry in ${path.relative(root, baselineFile)}`)
  process.exit(1)
}
if (!fs.existsSync(junitFile)) {
  console.error(`verify-skip-baseline: ${path.relative(root, junitFile)} does not exist — Vitest did not finish, or ran without CI set, so nothing was counted`)
  process.exit(1)
}

const report = readJunit(fs.readFileSync(junitFile, 'utf8'))
if (report.size === 0) error(`${path.relative(root, junitFile)} lists no test files`)

const listed = baseline.skippedFiles ?? {}
let total = 0
for (const [file, r] of [...report].sort()) {
  total += r.skipped
  const allowed = listed[file]
  if (r.skipped > 0 && allowed === undefined) error(`${file}: ${r.skipped} skipped, and it is not in the ${platform} baseline`)
  else if (allowed !== undefined && r.skipped > allowed) error(`${file}: ${r.skipped} skipped, baseline ${allowed}`)
  else if (allowed !== undefined && r.skipped < allowed) notice(`${file}: ${r.skipped} skipped, baseline ${allowed}`)
}
for (const file of Object.keys(listed)) {
  if (!report.has(file)) notice(`${file}: in the ${platform} baseline but not in this report (renamed or deleted?)`)
}
if (total > baseline.skippedCases) error(`${total} skipped cases on ${platform}, baseline ${baseline.skippedCases}`)
else if (total < baseline.skippedCases) notice(`${total} skipped cases on ${platform}, baseline ${baseline.skippedCases}`)

for (const file of baseline.mustRun ?? []) {
  const r = report.get(file)
  if (!r) error(`${file} must run on ${platform} but is not in the report`)
  else if (r.tests === 0 || r.skipped > 0) error(`${file} must run on ${platform}: ${r.tests} cases, ${r.skipped} skipped`)
}

const capsFile = path.join(path.dirname(junitFile), `capabilities-${platform}.json`)
if (fs.existsSync(capsFile)) {
  const { capabilities } = JSON.parse(fs.readFileSync(capsFile, 'utf8'))
  for (const [cap, s] of Object.entries(capabilities)) {
    if (s.manifest === 'required' && !s.ok) error(`capability ${cap} is required on ${platform} (test/capabilities.json) but absent: ${s.detail}`)
    else if (s.manifest === 'unknown' || s.manifest === null) capNotices.push(`capability ${cap} is "unknown" on ${platform} in test/capabilities.json; this machine: ${s.ok ? 'present' : 'absent'} (${s.detail})`)
    else if (s.manifest === 'absent' && s.ok) capNotices.push(`capability ${cap} is "absent" on ${platform} in test/capabilities.json, but present here (${s.detail})`)
  }
} else if (process.env.REDLOG_CI_CAPABILITIES === '1') {
  error(`${path.relative(root, capsFile)} was not written — the capability report did not run`)
}

console.log(`verify-skip-baseline (${platform}): ${report.size} files, ${total} skipped cases (baseline ${baseline.skippedCases})`)
for (const m of capNotices) console.log(gha ? `::notice title=capabilities::${m}` : `  capability: ${m}`)
for (const m of notices) console.log(gha ? `::notice title=skip baseline::${m} — lower test/skip-baseline.json` : `  notice: ${m}`)
for (const m of errors) console.log(gha ? `::error title=skip baseline::${m}` : `  error: ${m}`)
if (notices.length && !errors.length) console.log('Fewer skips than recorded: lower test/skip-baseline.json in this change.')
if (errors.length) {
  console.log(`\n${errors.length} problem(s). A new skip is a test that stopped running: make it run, or add it to the baseline in this change and say why.`)
  process.exit(1)
}
