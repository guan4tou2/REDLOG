import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// Smoke coverage for redlog-cli against a live app. The CLI had no automated
// tests at all before v0.9.4 — `redlog-sign` was the only covered binary —
// which is how `chain verify` shipped exiting 2 on a project that simply had
// not been anchored yet. Mirrors RELEASE_CHECKLIST §13.
test('redlog-cli smoke against a live app', async () => {
  test.setTimeout(180_000)
  const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-rel-'))
  const app = await electron.launch({
    args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openTestProject(page, 'release-check')
  await page.waitForTimeout(2000)

  const port = readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_TOKEN: token, REDLOG_PORT: port }
  const CLI = join(REPO_ROOT, 'cli', 'redlog-cli.js')

  const run = (args: string[]): { ok: boolean; out: string } => {
    try {
      return { ok: true, out: execFileSync('node', [CLI, ...args], { env, encoding: 'utf-8', timeout: 45_000 }).trim() }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string; status?: number }
      return { ok: false, out: `EXIT ${err.status}: ${(err.stdout || '') + (err.stderr || '') || err.message}`.trim() }
    }
  }

  // Seed one shell command_end so `replay` and the pairing check have material.
  await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_end', command: 'whoami', exit_code: 0, duration_sec: 0.1, stdout: 'operator\n', stdout_bytes: 9, source: 'cli-test' } })
  })
  await page.waitForTimeout(300)

  // `events` has no --json flag; pull the id straight off the REST API.
  const listed = await fetch(`http://127.0.0.1:${port}/api/events?agent_type=shell&limit=5`, {
    headers: { authorization: `Bearer ${token}` }
  }).then((r) => r.json()) as { events: Array<{ id: string }> }
  const shellId = listed.events[0]?.id || ''

  const steps: Array<[string, string[]]> = [
    ['whoami', ['whoami']],
    ['status', ['status']],
    ['health', ['health']],
    ['mark', ['mark', 'release-check', '--severity', 'info']],
    ['log', ['log', 'terminal', '--data', '{"subtype":"note","command":"cli-test"}']],
    ['search', ['search', 'release-check']],
    ['recording pause', ['recording', 'pause']],
    ['recording resume', ['recording', 'resume']],
    ['quickmark add', ['quickmark', 'add', 'cli mark', '--url', 'https://example.com']],
    ['quickmark list', ['quickmark', 'list']],
    ['screenshot', ['screenshot']],
    ['operators list', ['operators', 'list']],
    ['chain status', ['chain', 'status']],
    ['chain verify', ['chain', 'verify']],
    ['chain verify --full', ['chain', 'verify', '--full']],
    ['chain anchors', ['chain', 'anchors']],
    ['sanitize --dry-run', shellId ? ['sanitize', shellId, '--fields', 'command', '--dry-run', '--reason', 'release-check'] : ['sanitize', '--help']],
    ['export bundle', ['export', 'bundle']]
  ]

  const results: string[] = []
  const failures: string[] = []
  for (const [label, args] of steps) {
    const r = run(args)
    const first = r.out.split('\n').slice(0, 3).join(' | ').slice(0, 220)
    results.push(`${r.ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${first}`)
    if (!r.ok) failures.push(`${label}: ${first}`)
  }

  // `replay` is the one command that needs a real built-in terminal session
  // (it slices stdout out of that session's .cast), so it is checked for the
  // right refusal rather than success.
  const replay = run(shellId ? ['replay', shellId] : ['replay', 'MISSING-ID'])
  expect(replay.out, 'replay should refuse a non-builtin-terminal event by name')
    .toContain('not a builtin-terminal command_end event')

  // chain verify on a never-anchored project must not read as tampering.
  const cv = run(['chain', 'verify'])
  expect(cv.ok, 'chain verify must not exit non-zero just because nothing is anchored yet').toBeTruthy()
  expect(cv.out).toContain('NO ANCHOR YET')

  // §14: command_start/command_end pairing for builtin terminals.
  const all = await fetch(`http://127.0.0.1:${port}/api/events?limit=1000`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()) as { events: Array<{ agentType?: string; agent_type?: string; data?: Record<string, unknown> }> }
  const shells = all.events.filter((e) => (e.agentType || e.agent_type) === 'shell' && e.data?.source === 'builtin-terminal')
  const starts = shells.filter((e) => e.data?.subtype === 'command_start').length
  const ends = shells.filter((e) => e.data?.subtype === 'command_end').length
  results.push(`INFO  builtin-terminal shell events: ${starts} start / ${ends} end (0/0 = no terminal opened in this run)`)

  console.log('\n===== §13 CLI =====\n' + results.join('\n'))
  await app.close()
  expect(failures, `CLI commands failed:\n${failures.join('\n')}`).toEqual([])
})
