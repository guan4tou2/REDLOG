// Spec 071 FR-097 and the AI tailer. The tailer redacts a tool call's input
// (tailer-host.ts redactToolInput → deepRedactStrings) BEFORE the row reaches
// the writer, and the writer bounds the depth only then, so a secret inside a
// container stored as `_collapsed` text was masked when that text was written.
// deepRedactStrings and the size check after it no longer recurse, so a deep
// input neither overflows the stack nor stalls the session: the turns after it
// are captured. Driven through the real tailer, as test/agent-tailer.test.ts
// does: a transcript on disk, caught up, stored.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import { requires } from './helpers/requires'
import { stopAgentTailer } from '../src/main/services/agent-tailer'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession } from '../src/main/services/tailer-host'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'
import { COLLAPSED_KEY, MAX_DATA_DEPTH, restoreDataDepth } from '../src/core/ingest/depth'

const sqlite = requires('better-sqlite3')
const OP = 'operator-depth'
let scratch = ''

beforeEach(() => {
  configureHost({ enabled: false, enabledAgents: undefined, watchPathsByAgent: undefined, activationStarts: undefined })
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-depth-'))
  initDB(scratch)
  createOperator({ id: OP, name: 'Operator', token: generateToken() })
})
afterEach(() => {
  stopAgentTailer()
  try { closeDB() } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

// Assembled at run time: a token-shaped literal in a test is reported by the
// repository's secret scanner.
const TOKEN = ['gh', 'p_'].join('') + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c'

/** Write a transcript — a user message, an MCP tool call with `input`, a later
 *  user message — run the tailer over it, and return the stored agent rows. */
function tail(input: Record<string, unknown>): Array<Record<string, unknown>> {
  const claudeDir = path.join(scratch, 'claude-projects', '-tmp-proj')
  fs.mkdirSync(claudeDir, { recursive: true })
  const source = path.join(claudeDir, 'aaaaaaaa-bbbb-cccc-dddd-00000000d0e9.jsonl')
  // Built as text: JSON.stringify of the deepest inputs overflows in Node.
  const toolUse = `{"type":"tool_use","uuid":"u2","parentUuid":"u1","message":{"content":[{"type":"tool_use","id":"toolu_d","name":"mcp__probe__deep","input":${jsonText(input)}}]}}`
  fs.writeFileSync(source, [
    JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/tmp/proj', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    // An MCP tool is not in the allowlist, so its whole input is redacted.
    toolUse,
    JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'u2', cwd: '/tmp/proj', message: { role: 'user', content: [{ type: 'text', text: 'after-the-deep-one' }] } })
  ].join('\n') + '\n')
  claudeCodeAdapter.transcriptGlob = path.join(scratch, 'claude-projects', '**', '*.jsonl')
  registerAdapter(claudeCodeAdapter)
  configureHost({ enabled: true, identity: { projectId: 'p1', engagementId: 'e1', operatorId: OP },
    claudeProjectsDir: path.join(scratch, 'claude-projects'), idleFlushMs: 50, previewChars: 100, emitThinking: false } as never)
  registerSession('claude-code', source)
  return (getDB().prepare(`SELECT data FROM events WHERE agent_type = 'agent' ORDER BY rowid`).all() as Array<{ data: string }>)
    .map((r) => JSON.parse(r.data) as Record<string, unknown>)
}

/** JSON text of a value of any depth, for the transcript (the test's own; the
 *  code under test has its own). */
function jsonText(v: unknown): string {
  const out: string[] = []
  const stack: unknown[] = [v]
  while (stack.length) {
    const x = stack.pop()
    if (typeof x === 'object' && x !== null && 'close' in (x as object) && Object.keys(x as object).length === 1) { out.push((x as { close: string }).close); continue }
    if (Array.isArray(x)) {
      out.push('[')
      stack.push({ close: ']' })
      for (let i = x.length - 1; i >= 0; i--) { stack.push(x[i]); if (i > 0) stack.push({ close: ',' }) }
    } else if (x && typeof x === 'object') {
      out.push('{')
      stack.push({ close: '}' })
      const keys = Object.keys(x)
      for (let i = keys.length - 1; i >= 0; i--) { stack.push((x as Record<string, unknown>)[keys[i]]); stack.push({ close: `${i > 0 ? ',' : ''}${JSON.stringify(keys[i])}:` }) }
    } else out.push(JSON.stringify(x))
  }
  return out.join('')
}

/** `levels` arrays; the string `secret` at `at` levels below the top, too. */
function deep(levels: number, secrets: number[]): unknown {
  let v: unknown = { note: `inner ${TOKEN}` }
  for (let i = levels; i >= 1; i--) v = secrets.includes(i) ? [v, `at ${i} ${TOKEN}`] : [v]
  return v
}

const kinds = (rows: Array<Record<string, unknown>>): string[] => rows.map((d) => String(d.subtype))

sqlite.it('a secret nested past the bound in an AI tool\'s input is masked inside the collapsed text; the next turn is captured', () => {
  const rows = tail({ payload: deep(80, [70]) })
  expect(kinds(rows)).toEqual(['user_message', 'tool_call', 'user_message'])
  const call = rows[1]
  expect(call._ingest).toMatchObject({ collapsed: 1 })
  expect(JSON.stringify(call)).not.toContain(TOKEN)
  // data (1) → tool_input (2) → payload (3) → arrays; the container at 64 is the wrapper.
  let holder: unknown = (call.tool_input as Record<string, unknown>).payload
  for (let d = 3; d < MAX_DATA_DEPTH; d++) holder = (holder as unknown[])[0]
  expect(Object.keys(holder as object)).toEqual([COLLAPSED_KEY])
  expect((holder as Record<string, string>)[COLLAPSED_KEY]).toContain('REDACTED')
  // Restored from the stored row alone: both secrets are there, masked.
  const restored = JSON.stringify(restoreDataDepth(call))
  expect(restored.match(/REDACTED/g)?.length).toBeGreaterThanOrEqual(2)
  expect(rows[2].full).toBe('after-the-deep-one')
})

sqlite.it('a 40,000-level tool input: stored bounded, secrets at depth 80 and 39,000 masked, the next turn captured', () => {
  const rows = tail({ payload: deep(40_000, [78, 38_998]) })
  expect(kinds(rows)).toEqual(['user_message', 'tool_call', 'user_message'])
  const call = rows[1]
  expect(call.tool_input_truncated).toBeUndefined()
  expect(call._ingest).toMatchObject({ collapsed: 1 })
  const text = JSON.stringify(call)
  expect(text).not.toContain(TOKEN)
  // `at 78` sits inside the wrapper's text; restoring gives all three back, masked.
  const restoredText = (holderText: string): number => (holderText.match(/at (78|38998) /g) ?? []).length
  expect(restoredText(text)).toBe(2)
  expect(rows[2].full).toBe('after-the-deep-one')
})

// MAX_FULL_BYTES (100 KiB, tailer-host.ts) is older than FR-097 and not
// changed by it: an input whose JSON text is larger is stored as its top-level
// keys only (`tool_input_truncated`). A 100,000-level input is 200 KB of
// brackets, so that is what happens to it — and the session goes on.
sqlite.it('a 100,000-level tool input: no stack overflow, stored as the size cap has it, the next turn captured', () => {
  const rows = tail({ payload: deep(100_000, [80, 50_000]) })
  expect(kinds(rows)).toEqual(['user_message', 'tool_call', 'user_message'])
  expect(rows[1]).toMatchObject({ tool_input_truncated: true, tool_input: { _truncated: true, keys: ['payload'] } })
  expect(JSON.stringify(rows[1])).not.toContain(TOKEN)
  expect(rows[2].full).toBe('after-the-deep-one')
})
