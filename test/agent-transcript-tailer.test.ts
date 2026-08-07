import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseTranscriptLine,
  cwdPassesGate,
  isSelfExcludedCwd,
  readTranscriptCwd,
  registerSession,
  catchUpSession,
  _sessionsForTest,
  stopAgentTailer
} from '../src/main/services/agent-transcript-tailer'
import { initDB, closeDB } from '../src/core/db/index'
import { queryEvents } from '../src/core/db/events'
import { createOperator, generateToken } from '../src/core/db/operators'

let scratch: string
const OP = 'operator-1'

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-'))
  initDB(scratch)
  createOperator({ id: OP, name: 'Operator 1', token: generateToken() })
})

afterEach(() => {
  stopAgentTailer()
  try { closeDB() } catch { /* ignore */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('parseTranscriptLine', () => {
  it('extracts user message text + uuid', () => {
    const t = parseTranscriptLine({
      type: 'user', uuid: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] }
    })
    expect(t?.type).toBe('user')
    expect(t?.textContent).toBe('hello world')
    expect(t?.uuid).toBe('u1')
  })

  it('extracts tool_use with input + tool_use_id', () => {
    const t = parseTranscriptLine({
      type: 'tool_use', uuid: 'u2', parentUuid: 'u1',
      message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] }
    })
    expect(t?.toolName).toBe('Bash')
    expect(t?.toolUseId).toBe('toolu_x')
    expect(t?.toolInput?.command).toBe('ls')
    expect(t?.parentUuid).toBe('u1')
  })

  it('extracts tool_result with string content', () => {
    const t = parseTranscriptLine({
      type: 'tool_result', uuid: 'u3', parentUuid: 'u2',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'a\nb\nc' }] }
    })
    expect(t?.toolOutput).toBe('a\nb\nc')
    expect(t?.toolUseId).toBe('toolu_x')
  })

  it('extracts tool_result with array-of-text content', () => {
    const t = parseTranscriptLine({
      type: 'tool_result', uuid: 'u3',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x',
        content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }] }
    })
    expect(t?.toolOutput).toBe('line1\nline2')
  })

  it('flags isCompactSummary on user turn', () => {
    const t = parseTranscriptLine({
      type: 'user', uuid: 'u1', isCompactSummary: true,
      message: { content: [{ type: 'text', text: 'summary here' }] }
    })
    expect(t?.isCompactSummary).toBe(true)
  })

  it('picks up assistant model + token usage', () => {
    const t = parseTranscriptLine({
      type: 'assistant', uuid: 'u4', parentUuid: 'u1',
      message: {
        role: 'assistant', model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 42, output_tokens: 8 }
      }
    })
    expect(t?.model).toBe('claude-opus-4-7')
    expect(t?.usageTokensIn).toBe(42)
    expect(t?.usageTokensOut).toBe(8)
  })

  it('returns null for unknown line types', () => {
    expect(parseTranscriptLine({ type: 'summary', summary: 'x' })).toBeNull()
    expect(parseTranscriptLine({ type: 'mode', mode: 'default' })).toBeNull()
    expect(parseTranscriptLine({ type: 'queue-operation' })).toBeNull()
  })
})

describe('cwdPassesGate', () => {
  it('passes when both lists empty (default log everything)', () => {
    expect(cwdPassesGate('/tmp/proj')).toBe(true)
  })
  it('excludes if cwd matches an excludedPaths prefix', () => {
    expect(cwdPassesGate('/tmp/proj/x', ['/tmp/proj'])).toBe(false)
    expect(cwdPassesGate('/tmp/proj', ['/tmp/proj'])).toBe(false)
    expect(cwdPassesGate('/tmp/other', ['/tmp/proj'])).toBe(true)
  })
  it('respects legacy watchPaths whitelist', () => {
    expect(cwdPassesGate('/tmp/proj/x', [], ['/tmp/proj'])).toBe(true)
    expect(cwdPassesGate('/tmp/other', [], ['/tmp/proj'])).toBe(false)
  })
  it('handles ~ expansion', () => {
    const home = os.homedir()
    expect(cwdPassesGate(path.join(home, 'x/y'), ['~/x'])).toBe(false)
  })
})

describe('isSelfExcludedCwd', () => {
  it('finds marker in cwd itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-'))
    fs.writeFileSync(path.join(dir, '.redlog-app-root'), '')
    expect(isSelfExcludedCwd(dir, '.redlog-app-root')).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it('walks up to find marker in ancestor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-'))
    const nested = path.join(dir, 'a', 'b', 'c')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(dir, '.redlog-app-root'), '')
    expect(isSelfExcludedCwd(nested, '.redlog-app-root')).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it('returns false when no marker anywhere', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-'))
    expect(isSelfExcludedCwd(dir, '.redlog-app-root')).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('readTranscriptCwd', () => {
  it('skips metadata lines and returns cwd from first record that has one', () => {
    const p = path.join(scratch, 'session.jsonl')
    fs.writeFileSync(p, [
      JSON.stringify({ type: 'summary', summary: 's' }),
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/Users/foo/proj', message: {} })
    ].join('\n') + '\n')
    expect(readTranscriptCwd(p)).toBe('/Users/foo/proj')
  })
  it('returns null if no cwd within scan window', () => {
    const p = path.join(scratch, 's.jsonl')
    fs.writeFileSync(p, JSON.stringify({ type: 'summary' }) + '\n')
    expect(readTranscriptCwd(p, 10)).toBeNull()
  })
})

describe('catchUpSession — end-to-end', () => {
  it('emits per-turn events + snapshot on idle, dedup on re-run', () => {
    // Fake Claude Code transcript in a scratch "claude-projects" dir.
    const claudeDir = path.join(scratch, 'claude-projects', '-tmp-proj')
    fs.mkdirSync(claudeDir, { recursive: true })
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-000000000001'
    const source = path.join(claudeDir, `${sid}.jsonl`)
    fs.writeFileSync(source, [
      JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/tmp/proj',
        message: { role: 'user', content: [{ type: 'text', text: 'find bugs' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'u2', parentUuid: 'u1',
        message: { role: 'assistant', model: 'claude-opus',
          content: [{ type: 'text', text: 'sure' }], usage: { input_tokens: 5, output_tokens: 3 } } }),
      JSON.stringify({ type: 'tool_use', uuid: 'u3', parentUuid: 'u2',
        message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'tool_result', uuid: 'u4', parentUuid: 'u3',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'a\nb' }] } })
    ].join('\n') + '\n')

    const cfgSnap = {
      enabled: true, engagementId: 'e1', operatorId: OP,
      claudeProjectsDir: path.join(scratch, 'claude-projects'),
      idleFlushMs: 50, previewChars: 100, emitThinking: false
    }
    registerSession(source, cfgSnap)

    const sessions = _sessionsForTest()
    expect(sessions.size).toBe(1)
    const s = [...sessions.values()][0]
    expect(s.turnsEmitted).toBe(4)

    // Chain-linking: each child references its parent's RedLog id via _causes.
    const rows = queryEvents({ agentType: 'agent', limit: 100 })
    const bySubtype = new Map(rows.map((r) => [r.data.subtype as string, r]))
    expect(bySubtype.has('user_message')).toBe(true)
    expect(bySubtype.has('assistant_message')).toBe(true)
    expect(bySubtype.has('tool_call')).toBe(true)
    expect(bySubtype.has('tool_result')).toBe(true)
    const asst = bySubtype.get('assistant_message')!
    const user = bySubtype.get('user_message')!
    expect((asst.data._causes as string[])?.[0]).toBe(user.id)
    expect(asst.data.model).toBe('claude-opus')
    expect(asst.data.usage_tokens_in).toBe(5)

    // Re-run catchUp with unchanged file → no new events (uuid dedup).
    catchUpSession(s.sessionId, cfgSnap)
    const rows2 = queryEvents({ agentType: 'agent', limit: 100 })
    expect(rows2.length).toBe(rows.length)

    // Append a new turn → only that turn emits.
    fs.appendFileSync(source, JSON.stringify({
      type: 'user', uuid: 'u5', parentUuid: 'u4',
      message: { role: 'user', content: [{ type: 'text', text: 'thanks' }] }
    }) + '\n')
    catchUpSession(s.sessionId, cfgSnap)
    const rows3 = queryEvents({ agentType: 'agent', limit: 100 })
    expect(rows3.length).toBe(rows.length + 1)
  })

  it('detects compaction (source shrinks) and emits transcript_compacted', () => {
    const claudeDir = path.join(scratch, 'claude-projects', '-tmp-p')
    fs.mkdirSync(claudeDir, { recursive: true })
    const sid = 'bbbbbbbb-bbbb-cccc-dddd-000000000002'
    const source = path.join(claudeDir, `${sid}.jsonl`)
    fs.writeFileSync(source, [
      JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/tmp/p',
        message: { role: 'user', content: [{ type: 'text', text: 'a'.repeat(2000) }] } })
    ].join('\n') + '\n')
    const cfgSnap = {
      enabled: true, engagementId: 'e1', operatorId: OP,
      claudeProjectsDir: path.join(scratch, 'claude-projects'),
      idleFlushMs: 50, previewChars: 100
    }
    registerSession(source, cfgSnap)
    // Simulate /compact: rewrite the source shorter.
    fs.writeFileSync(source, [
      JSON.stringify({ type: 'user', uuid: 'u9', cwd: '/tmp/p', isCompactSummary: true,
        message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } })
    ].join('\n') + '\n')
    catchUpSession(sid, cfgSnap)
    const rows = queryEvents({ agentType: 'agent', limit: 100 })
    expect(rows.some((r) => r.data.subtype === 'transcript_compacted')).toBe(true)
    expect(rows.some((r) => r.data.subtype === 'compact_summary')).toBe(true)
  })

  it('buffers partial trailing line across ticks', () => {
    const claudeDir = path.join(scratch, 'claude-projects', '-tmp-q')
    fs.mkdirSync(claudeDir, { recursive: true })
    const sid = 'cccccccc-bbbb-cccc-dddd-000000000003'
    const source = path.join(claudeDir, `${sid}.jsonl`)
    // First write: one complete line + a partial (no trailing \n).
    const line1 = JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/tmp/q',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n'
    const partial = '{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"role":"assist'
    fs.writeFileSync(source, line1 + partial)
    const cfgSnap = {
      enabled: true, engagementId: 'e1', operatorId: OP,
      claudeProjectsDir: path.join(scratch, 'claude-projects'),
      idleFlushMs: 50, previewChars: 100
    }
    registerSession(source, cfgSnap)
    let rows = queryEvents({ agentType: 'agent', limit: 100 })
    // Only the complete line should emit.
    expect(rows.filter((r) => r.data.subtype === 'user_message').length).toBe(1)
    expect(rows.filter((r) => r.data.subtype === 'assistant_message').length).toBe(0)
    // Complete the partial line.
    const rest = 'ant","content":[{"type":"text","text":"ok"}]}}\n'
    fs.appendFileSync(source, rest)
    catchUpSession(sid, cfgSnap)
    rows = queryEvents({ agentType: 'agent', limit: 100 })
    expect(rows.filter((r) => r.data.subtype === 'assistant_message').length).toBe(1)
  })

  it('respects self-exclusion marker', () => {
    const claudeDir = path.join(scratch, 'claude-projects', '-self-')
    fs.mkdirSync(claudeDir, { recursive: true })
    // Fake project cwd with the marker.
    const projCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'selfp-'))
    fs.writeFileSync(path.join(projCwd, '.redlog-app-root'), '')
    const sid = 'dddddddd-bbbb-cccc-dddd-000000000004'
    const source = path.join(claudeDir, `${sid}.jsonl`)
    fs.writeFileSync(source, JSON.stringify({
      type: 'user', uuid: 'u1', cwd: projCwd,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    }) + '\n')
    registerSession(source, {
      enabled: true, engagementId: 'e1', operatorId: OP,
      claudeProjectsDir: path.join(scratch, 'claude-projects'),
      idleFlushMs: 50, selfExclusionMarker: '.redlog-app-root'
    })
    expect(_sessionsForTest().size).toBe(0)
    fs.rmSync(projCwd, { recursive: true, force: true })
  })
})
