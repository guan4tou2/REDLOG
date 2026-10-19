import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describeAgentSources, configureAgentTailer } from '../src/main/services/agent-tailer'

// The settings page says which AI tools RedLog can read and whether each one is
// on this machine. It must only look at directories — never open a transcript.

describe('describeAgentSources', () => {
  let scratch = ''
  afterEach(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }) })

  it('lists the three adapters with the folder each one watches', () => {
    const sources = describeAgentSources()
    expect(sources.map((s) => s.id)).toEqual(['claude-code', 'codex', 'opencode'])
    for (const s of sources) {
      expect(s.root).not.toMatch(/[*?[{]/)
      expect(path.isAbsolute(s.root)).toBe(true)
    }
  })

  it('reports detected only when the watched folder exists', () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sources-'))
    const claude = path.join(scratch, 'claude-projects')
    fs.mkdirSync(claude)
    configureAgentTailer({
      claudeProjectsDir: claude,
      codexSessionsDir: path.join(scratch, 'no-codex'),
      opencodeStorageDir: path.join(scratch, 'no-opencode')
    })
    const byId = Object.fromEntries(describeAgentSources().map((s) => [s.id, s]))
    expect(byId['claude-code'].detected).toBe(true)
    expect(byId['claude-code'].root).toBe(claude)
    expect(byId.codex.detected).toBe(false)
    expect(byId.opencode.detected).toBe(false)
  })
})
