// Spec 071 FR-097 and redaction: the AI tailer redacts a tool call's input
// (tailer-host.ts redactToolInput → deepRedactStrings) BEFORE the row reaches
// the writer, and the writer collapses what is nested too deep only then. So
// a secret inside a container that is stored as JSON text was already masked
// when that text was written. Driven through the real tailer, as
// test/agent-tailer.test.ts does: a transcript on disk, caught up, stored.

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
import { MAX_DATA_DEPTH } from '../src/core/ingest/depth'

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

sqlite.it('a secret nested past the bound in an AI tool\'s input is masked inside the collapsed text', () => {
  // Assembled at run time: a token-shaped literal in a test is reported by the
  // repository's secret scanner.
  const token = ['gh', 'p_'].join('') + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c'
  expect(token).toHaveLength(40)
  let deep: unknown = { note: `use ${token} here` }
  for (let i = 0; i < 80; i++) deep = [deep]
  const claudeDir = path.join(scratch, 'claude-projects', '-tmp-proj')
  fs.mkdirSync(claudeDir, { recursive: true })
  const source = path.join(claudeDir, 'aaaaaaaa-bbbb-cccc-dddd-00000000d0e9.jsonl')
  fs.writeFileSync(source, [
    JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/tmp/proj', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    // An MCP tool is not in the allowlist, so its whole input is redacted.
    JSON.stringify({ type: 'tool_use', uuid: 'u2', parentUuid: 'u1',
      message: { content: [{ type: 'tool_use', id: 'toolu_d', name: 'mcp__probe__deep', input: { payload: deep } }] } })
  ].join('\n') + '\n')
  claudeCodeAdapter.transcriptGlob = path.join(scratch, 'claude-projects', '**', '*.jsonl')
  registerAdapter(claudeCodeAdapter)
  configureHost({ enabled: true, identity: { projectId: 'p1', engagementId: 'e1', operatorId: OP },
    claudeProjectsDir: path.join(scratch, 'claude-projects'), idleFlushMs: 50, previewChars: 100, emitThinking: false } as never)
  registerSession('claude-code', source)

  const rows = getDB().prepare(`SELECT data FROM events WHERE agent_type = 'agent'`).all() as Array<{ data: string }>
  const call = rows.map((r) => JSON.parse(r.data) as Record<string, unknown>).find((d) => d.subtype === 'tool_call')
  expect(call, 'the tool call was stored').toBeDefined()
  expect(call!._ingest).toMatchObject({ collapsed: 1 })
  const text = JSON.stringify(call)
  expect(text).not.toContain(token)
  // data (1) → tool_input (2) → payload (3) → arrays to 64; the 65th is text.
  let holder: unknown = (call!.tool_input as Record<string, unknown>).payload
  for (let d = 3; d < MAX_DATA_DEPTH; d++) holder = (holder as unknown[])[0]
  const collapsed = (holder as unknown[])[0]
  expect(typeof collapsed).toBe('string')
  expect(collapsed as string).toContain('REDACTED')
  expect(JSON.parse(collapsed as string)).toBeInstanceOf(Array)
})
