import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'
interface T { spawn: (i: string, c: number, r: number) => Promise<unknown>; write: (i: string, d: string) => void; kill: (i: string) => void }

// v0.11.2 (design note T5). The Timeline answers "when did this happen and
// what did it cause"; the transcript answers "what did I type and what came
// back" — the question an operator asks when writing an engagement up, which
// previously meant clicking dots one at a time.
//
// What is asserted here is the folding: a tool_call and its tool_result are
// ONE exchange, not two rows, and likewise an HTTP request and its response.
// Getting that wrong is what makes a transcript unreadable.
test('folds request/response pairs into single exchanges', async () => {
  test.setTimeout(180_000)
  const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-tr-'))
  const app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
  await openTestProject(page, 'tr')
  await page.waitForTimeout(1500)
  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  const post = (agent_type: string, data: Record<string, unknown>) => fetch(`${base}/api/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_type, data }) })

  // A shell command with no captured output (external shell)
  await post('shell', { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', exit_code: 0, duration_sec: 12, source: 'shell-hook' })
  // An HTTP exchange with a response body
  await post('scanner', { subtype: 'http_request_start', flow_id: 'f1', method: 'GET', url: 'https://t.example/api/users', params: { query: { page: '1' } } })
  await post('scanner', { subtype: 'http_response', flow_id: 'f1', method: 'GET', url: 'https://t.example/api/users', status: 200, content_length: 42, duration_ms: 87, response_preview: '{"users":[{"id":1,"name":"admin"}]}' })
  // An agent tool call + result
  await post('agent', { subtype: 'tool_call', agent: 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'id' } })
  await post('agent', { subtype: 'tool_result', agent: 'claude-code', tool_use_id: 'tu1', output: 'uid=0(root) gid=0(root)' })
  await post('marker', { title: 'found admin panel', severity: 'important' })
  await page.waitForTimeout(1500)

  await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000) })
  await page.click('button:has-text("Transcript")')
  await page.waitForTimeout(1500)

  const txt = await page.evaluate(() => document.body.innerText)
  // Six events in, four exchanges out: the two pairs each collapse to one.
  const blocks = await page.evaluate(() =>
    document.querySelectorAll('div.rounded.border.border-zinc-800\\/70').length)
  expect(blocks, 'a call and its result must render as one exchange').toBe(4)

  expect(txt, 'the command itself').toMatch(/nmap -sV 10\.0\.0\.5/)
  expect(txt, 'the request line').toMatch(/GET https:\/\/t\.example/)
  expect(txt, 'the response body, which had no UI at all before this').toMatch(/"name":"admin"/)
  expect(txt, 'a tool result shown under the call that produced it').toMatch(/uid=0\(root\)/)
  // Absence stated, not implied — an external shell records the command only,
  // and that has to look different from a command that printed nothing.
  expect(txt, 'uncaptured output must say so').toMatch(/output not captured/)
  await app.close()
})
