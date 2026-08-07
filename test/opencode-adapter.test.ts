import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseOpencodeMessage, readOpenCodeCwd, opencodeAdapter,
  partToTurns
} from '../src/main/services/adapters/opencode'

let scratch: string
let storage: string

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-'))
  storage = path.join(scratch, 'storage')
  fs.mkdirSync(path.join(storage, 'message'), { recursive: true })
  fs.mkdirSync(path.join(storage, 'part'), { recursive: true })
  fs.mkdirSync(path.join(storage, 'session'), { recursive: true })
})
afterEach(() => { try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ } })

function seedMsg(sid: string, mid: string, stub: Record<string, unknown>, parts: Array<Record<string, unknown>>): string {
  const sesDir = path.join(storage, 'message', sid)
  fs.mkdirSync(sesDir, { recursive: true })
  const msgPath = path.join(sesDir, `${mid}.json`)
  fs.writeFileSync(msgPath, JSON.stringify({ id: mid, sessionID: sid, ...stub }))
  const partsDir = path.join(storage, 'part', mid)
  fs.mkdirSync(partsDir, { recursive: true })
  parts.forEach((p, i) => {
    const pid = `prt_${mid.slice(4)}_${i}`
    fs.writeFileSync(path.join(partsDir, `${pid}.json`), JSON.stringify({ id: pid, messageID: mid, sessionID: sid, ...p }))
  })
  return msgPath
}

describe('parseOpencodeMessage', () => {
  it('returns [] when msg stub is unparseable', () => {
    const p = seedMsg('ses_a', 'msg_a', { role: 'user' }, [])
    fs.writeFileSync(p, 'not json')
    expect(parseOpencodeMessage(fs.readFileSync(p, 'utf-8'), p)).toEqual([])
  })

  it('assembles user message with two text parts', () => {
    const p = seedMsg('ses_b', 'msg_b', { role: 'user' }, [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' }
    ])
    const turns = parseOpencodeMessage(fs.readFileSync(p, 'utf-8'), p)
    expect(turns.length).toBe(1)
    expect(turns[0].type).toBe('user_message')
    expect(turns[0].textContent).toBe('first\nsecond')
    expect(turns[0].uuid).toBe('opencode:msg:msg_b')
  })

  it('emits reasoning parts as separate thinking turns with msg parentUuid', () => {
    const p = seedMsg('ses_c', 'msg_c', { role: 'assistant', model: { modelID: 'sonnet' } }, [
      { type: 'text', text: 'response' },
      { type: 'reasoning', text: 'chain-of-thought' },
      { type: 'reasoning', text: 'more thinking' }
    ])
    const turns = parseOpencodeMessage(fs.readFileSync(p, 'utf-8'), p)
    expect(turns.length).toBe(3)  // 1 msg + 2 thinking
    expect(turns[0].type).toBe('assistant_message')
    expect(turns[0].model).toBe('sonnet')
    expect(turns[0].hasThinking).toBe(true)
    expect(turns[1].type).toBe('thinking')
    expect(turns[1].parentUuid).toBe('opencode:msg:msg_c')
    expect(turns[1].textContent).toBe('chain-of-thought')
    expect(turns[2].textContent).toBe('more thinking')
  })

  it('tool part fans out to tool_call + tool_result linked by callID', () => {
    const p = seedMsg('ses_d', 'msg_d', { role: 'assistant' }, [
      { type: 'tool', callID: 'call_z', tool: 'bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb' } }
    ])
    const turns = parseOpencodeMessage(fs.readFileSync(p, 'utf-8'), p)
    expect(turns.length).toBe(3)  // msg + call + result
    const call = turns[1]
    const res = turns[2]
    expect(call.type).toBe('tool_call')
    expect(call.uuid).toBe('opencode:tc:call_z')
    expect(call.toolName).toBe('bash')
    expect(call.toolInput?.command).toBe('ls')
    expect(res.type).toBe('tool_result')
    expect(res.uuid).toBe('opencode:tr:call_z')
    expect(res.parentUuid).toBe('opencode:tc:call_z')
    expect(res.toolOutput).toBe('a\nb')
  })

  it('pending tool emits tool_call but no tool_result yet', () => {
    const p = seedMsg('ses_e', 'msg_e', { role: 'assistant' }, [
      { type: 'tool', callID: 'call_p', tool: 'grep',
        state: { status: 'pending', input: { pattern: 'foo' } } }
    ])
    const turns = parseOpencodeMessage(fs.readFileSync(p, 'utf-8'), p)
    expect(turns.length).toBe(2)  // msg + tool_call (no result)
    expect(turns[1].type).toBe('tool_call')
    expect(turns.find((t) => t.type === 'tool_result')).toBeUndefined()
  })

  it('empty parts dir → just the msg turn with no content', () => {
    const p = seedMsg('ses_f', 'msg_f', { role: 'user' }, [])
    const turns = parseOpencodeMessage(fs.readFileSync(p, 'utf-8'), p)
    expect(turns.length).toBe(1)
    expect(turns[0].textContent).toBeUndefined()
  })

  it('parentID on stub becomes msg parentUuid for prior message', () => {
    const p = seedMsg('ses_g', 'msg_g2', { role: 'assistant', parentID: 'msg_g1' }, [
      { type: 'text', text: 'reply' }
    ])
    const turns = parseOpencodeMessage(fs.readFileSync(p, 'utf-8'), p)
    expect(turns[0].parentUuid).toBe('opencode:msg:msg_g1')
  })

  it('subtypeFor is passthrough — adapter internal types match emit subtypes', () => {
    for (const t of ['user_message', 'assistant_message', 'thinking', 'tool_call', 'tool_result']) {
      expect(opencodeAdapter.subtypeFor({ uuid: 'x', parentUuid: null, type: t })).toBe(t)
    }
  })
})

describe('partToTurns (v0.8.3 secondary watcher)', () => {
  it('reasoning part → single thinking turn with msg parentUuid', () => {
    const turns = partToTurns('msg_x', {
      id: 'prt_r', type: 'reasoning', text: 'thinking-out-loud'
    })
    expect(turns.length).toBe(1)
    expect(turns[0].type).toBe('thinking')
    expect(turns[0].uuid).toBe('opencode:reason:prt_r')
    expect(turns[0].parentUuid).toBe('opencode:msg:msg_x')
    expect(turns[0].textContent).toBe('thinking-out-loud')
  })

  it('pending tool part → tool_call only, no tool_result', () => {
    const turns = partToTurns('msg_y', {
      id: 'prt_t', type: 'tool', callID: 'call_a', tool: 'bash',
      state: { status: 'pending', input: { command: 'ls' } }
    })
    expect(turns.length).toBe(1)
    expect(turns[0].type).toBe('tool_call')
    expect(turns[0].uuid).toBe('opencode:tc:call_a')
  })

  it('completed tool part → tool_call + tool_result chain-linked', () => {
    const turns = partToTurns('msg_z', {
      id: 'prt_t2', type: 'tool', callID: 'call_b', tool: 'bash',
      state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb' }
    })
    expect(turns.length).toBe(2)
    expect(turns[0].type).toBe('tool_call')
    expect(turns[0].uuid).toBe('opencode:tc:call_b')
    expect(turns[1].type).toBe('tool_result')
    expect(turns[1].uuid).toBe('opencode:tr:call_b')
    expect(turns[1].parentUuid).toBe('opencode:tc:call_b')
    expect(turns[1].toolOutput).toBe('a\nb')
  })

  it('text part → NO turns (msg-level fold-in only)', () => {
    // Text parts arriving after the msg stub was first observed don't
    // re-emit; the message event is immutable once appended.
    expect(partToTurns('msg_t', { id: 'prt_x', type: 'text', text: 'hi' })).toEqual([])
  })

  it('unknown part type → []', () => {
    expect(partToTurns('m', { id: 'p', type: 'step-start' })).toEqual([])
    expect(partToTurns('m', { id: 'p', type: 'step-finish' })).toEqual([])
    expect(partToTurns('m', { id: 'p', type: 'nonsense' })).toEqual([])
  })

  it('tool part with error status still emits both halves', () => {
    const turns = partToTurns('m', {
      id: 'p', type: 'tool', callID: 'c', tool: 'grep',
      state: { status: 'error', input: { pattern: 'x' }, output: 'not found' }
    })
    expect(turns.length).toBe(2)
    expect(turns[0].type).toBe('tool_call')
    expect(turns[1].type).toBe('tool_result')
  })
})

describe('readOpenCodeCwd', () => {
  it('finds cwd from session metadata under a project-hash subdir', () => {
    const sesDir = path.join(storage, 'message', 'ses_h')
    fs.mkdirSync(sesDir, { recursive: true })
    const projDir = path.join(storage, 'session', 'projhash_abc')
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(path.join(projDir, 'ses_h.json'),
      JSON.stringify({ id: 'ses_h', directory: '/Users/foo/opencode-proj' }))
    expect(readOpenCodeCwd(sesDir)).toBe('/Users/foo/opencode-proj')
  })

  it('returns null when session file is missing', () => {
    const sesDir = path.join(storage, 'message', 'ses_missing')
    fs.mkdirSync(sesDir, { recursive: true })
    expect(readOpenCodeCwd(sesDir)).toBeNull()
  })
})
