import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const m = vi.hoisted(() => ({ project: '', ingest: vi.fn(() => ({ id: 'turn' })), watchers: [] as Array<Record<string, (...args: string[]) => void>> }))
vi.mock('../src/core/db/index', () => ({ getProjectDir: () => m.project, getDB: () => ({ prepare: () => ({ all: () => [] }) }) }))
vi.mock('../src/core/ingest', () => ({ ingestEvent: m.ingest }))
vi.mock('../src/core/capture-health', () => ({ noteDbError: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => { const callbacks: Record<string, (...args: string[]) => void> = {}; m.watchers.push(callbacks); return { on(name: string, fn: (...args: string[]) => void) { callbacks[name] = fn; return this }, close: async () => { } } } } }))
import { configureHost, registerAdapter, unregisterAdapter, registerSession, catchUpSession, stopHost, type TailerAdapter } from '../src/main/services/tailer-host'
let root: string
let source: string
let cwd: string
let init: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>
let resolve: ReturnType<typeof vi.fn>
const startedAt = 1_800_000_000_000
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-source-')); m.project = path.join(root, 'project'); fs.mkdirSync(m.project)
  cwd = path.join(root, 'work'); fs.mkdirSync(cwd)
  source = path.join(root, 'session.jsonl'); fs.writeFileSync(source, JSON.stringify({ type: 'user', uuid: 'old', textContent: 'old history', sourceTimestamp: 1 }) + '\n')
  init = vi.fn(); stop = vi.fn(); resolve = vi.fn(() => cwd); m.ingest.mockClear(); m.watchers.length = 0
})
afterEach(() => { stopHost(); unregisterAdapter('codex'); fs.rmSync(root, { recursive: true, force: true }) })
function adapter(): TailerAdapter { return { agentKind: 'codex', transcriptGlob: root + '/*.jsonl', knownIngestTypes: new Set(['user']), knownIgnoredTypes: new Set(), resolveCwd: resolve, parseUnit: JSON.parse, subtypeFor: () => 'user_message', init, stop } as TailerAdapter }
function enable() { configureHost({ enabled: true, engagementId: 'eng-a', operatorId: 'op', enabledAgents: ['codex'], watchPathsByAgent: { codex: [cwd] }, activationStarts: { codex: startedAt } }) }
describe('AI capture lifecycle', () => {
  it('does not initialize an adapter or read a disabled source', () => {
    configureHost({ enabled: false, engagementId: 'eng-a', operatorId: 'op', enabledAgents: [] })
    registerAdapter(adapter()); registerSession('codex', source)
    expect(init).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled()
  })
  it('refuses an empty project path list before opening a transcript', () => {
    registerAdapter(adapter()); enable()
    configureHost({ watchPathsByAgent: { codex: [] } })
    registerSession('codex', source)
    expect(resolve).not.toHaveBeenCalled()
  })
  it('rejects a source without cwd or outside the project directories', () => {
    registerAdapter(adapter()); enable()
    resolve.mockReturnValueOnce(null); registerSession('codex', source)
    resolve.mockReturnValueOnce(root); registerSession('codex', source)
    expect(m.ingest).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(m.project, 'agent-transcripts'))).toBe(false)
  })
  it('starts at the current end of an existing session and preserves only subsequent data', () => {
    registerAdapter(adapter()); enable(); registerSession('codex', source)
    expect(m.ingest.mock.calls.some(c => (c as unknown[])[1] && JSON.stringify(c).includes('old history'))).toBe(false)
    fs.appendFileSync(source, JSON.stringify({ type: 'user', uuid: 'new', textContent: 'new turn', sourceTimestamp: startedAt + 1 }) + '\n')
    catchUpSession('codex', 'session')
    expect(JSON.stringify(m.ingest.mock.calls)).toContain('new turn')
    const sidecars = fs.readdirSync(path.join(m.project, 'agent-transcripts')).filter(p => p.endsWith('.jsonl'))
    expect(fs.readFileSync(path.join(m.project, 'agent-transcripts', sidecars[0]), 'utf8')).not.toContain('old history')
    stopHost(); enable(); registerSession('codex', source)
    expect(m.ingest.mock.calls.filter(c => (c as unknown[] as [string, { subtype: string }])[1].subtype === 'user_message')).toHaveLength(1)
  })
  it('stops auxiliary watchers and ignores callbacks belonging to a previous project', () => {
    registerAdapter(adapter()); enable()
    const old = m.watchers[0]; expect(old).toBeTruthy()
    stopHost(); expect(stop).toHaveBeenCalled()
    const oldControl = init.mock.calls[0][0]
    m.project = path.join(root, 'project-b'); fs.mkdirSync(m.project)
    configureHost({ engagementId: 'eng-b', enabledAgents: ['codex'], enabled: true })
    resolve.mockClear(); m.ingest.mockClear(); old.add(source)
    oldControl.emitTurns('codex', 'session', [{ type: 'user', uuid: 'stale', textContent: 'stale callback' }])
    expect(resolve).not.toHaveBeenCalled(); expect(m.ingest).not.toHaveBeenCalled()
  })
})
