import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseCodexLine, readCodexCwd, codexAdapter,
  CODEX_INGEST_TYPES, CODEX_IGNORED_TYPES
} from '../src/main/services/adapters/codex'

let scratch: string
beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-')) })
afterEach(() => { try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('parseCodexLine', () => {
  it('returns null-uuid stub for session_meta so host neither emits nor drift-alerts', () => {
    const t = parseCodexLine(JSON.stringify({
      type: 'session_meta',
      payload: { cwd: '/tmp/x', id: 'abc', model_provider: 'openai' }
    }))
    expect(t?.type).toBe('session_meta')
    expect(t?.uuid).toBeNull()
  })

  it('extracts assistant message text + role', () => {
    const t = parseCodexLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }, { type: 'output_text', text: 'there' }]
      }
    })) as { uuid: string; role?: string; textContent?: string }
    expect(t.role).toBe('assistant')
    expect(t.textContent).toBe('hi\nthere')
    expect(t.uuid).toMatch(/^codex:[0-9a-f]{16}$/)
  })

  it('links function_call ↔ function_call_output via call_id', () => {
    const call = parseCodexLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'shell_command', call_id: 'call_XYZ',
        arguments: '{"command":"ls","workdir":"/tmp"}'
      }
    })) as { uuid: string; toolName?: string; toolInput?: Record<string, unknown> }
    const out = parseCodexLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_XYZ', output: 'a\nb' }
    })) as { uuid: string; parentUuid: string | null; toolOutput?: string }
    expect(call.uuid).toBe('codex:fc:call_XYZ')
    expect(call.toolName).toBe('shell_command')
    expect(call.toolInput?.command).toBe('ls')
    expect(out.uuid).toBe('codex:fco:call_XYZ')
    expect(out.parentUuid).toBe('codex:fc:call_XYZ')
    expect(out.toolOutput).toBe('a\nb')
  })

  it('marks reasoning as thinking', () => {
    const t = parseCodexLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'gAAAAA...', summary: [] }
    })) as { hasThinking?: boolean; type: string }
    expect(t.hasThinking).toBe(true)
    expect(t.type).toBe('reasoning')
  })

  it('marks context_compacted as isCompactSummary', () => {
    const t = parseCodexLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'context_compacted' }
    })) as { isCompactSummary?: boolean }
    expect(t.isCompactSummary).toBe(true)
  })

  it('drops ignored payload types', () => {
    for (const kind of ['task_started', 'task_complete', 'token_count', 'thread_name_updated']) {
      expect(parseCodexLine(JSON.stringify({ type: 'response_item', payload: { type: kind } }))).toBeNull()
    }
  })

  it('agent_message routes to assistant, user_message to user', () => {
    const a = parseCodexLine(JSON.stringify({
      type: 'response_item', payload: { type: 'agent_message', message: 'hey', phase: 'final_answer' }
    })) as { role?: string; textContent?: string }
    const u = parseCodexLine(JSON.stringify({
      type: 'response_item', payload: { type: 'user_message', message: 'ok' }
    })) as { role?: string; textContent?: string }
    expect(a.role).toBe('assistant')
    expect(a.textContent).toBe('hey')
    expect(u.role).toBe('user')
    expect(u.textContent).toBe('ok')
  })

  it('subtypeFor covers all ingest types', () => {
    // Anything the parser can produce should have a defined subtype path.
    // Spot-check the important cases:
    const cases: Array<{ raw: string; expected: string }> = [
      { raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] } }), expected: 'user_message' },
      { raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y' }] } }), expected: 'assistant_message' },
      { raw: JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' } }), expected: 'tool_call' },
      { raw: JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }), expected: 'tool_result' },
      { raw: JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }), expected: 'thinking' },
      { raw: JSON.stringify({ type: 'response_item', payload: { type: 'context_compacted' } }), expected: 'compact_summary' }
    ]
    for (const c of cases) {
      const t = parseCodexLine(c.raw)!
      expect(codexAdapter.subtypeFor(t)).toBe(c.expected)
    }
  })

  it('ingest + ignored sets cover the observed payload universe', () => {
    // Sanity check the whitelist matches what parseCodexLine actually handles.
    expect(CODEX_INGEST_TYPES.has('message')).toBe(true)
    expect(CODEX_INGEST_TYPES.has('function_call')).toBe(true)
    expect(CODEX_INGEST_TYPES.has('context_compacted')).toBe(true)
    expect(CODEX_IGNORED_TYPES.has('token_count')).toBe(true)
    expect(CODEX_IGNORED_TYPES.has('task_complete')).toBe(true)
  })
})

describe('readCodexCwd', () => {
  it('returns cwd from the session_meta header', () => {
    const p = path.join(scratch, 'rollout-x.jsonl')
    fs.writeFileSync(p, [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/foo/proj', id: 'x' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } })
    ].join('\n') + '\n')
    expect(readCodexCwd(p)).toBe('/Users/foo/proj')
  })

  it('returns null when no session_meta within scan window', () => {
    const p = path.join(scratch, 'rollout-y.jsonl')
    fs.writeFileSync(p, JSON.stringify({ type: 'response_item', payload: { type: 'message' } }) + '\n')
    expect(readCodexCwd(p, 5)).toBeNull()
  })
})
