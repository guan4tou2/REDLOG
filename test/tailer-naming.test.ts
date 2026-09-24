import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig } from '../src/core/config'

// Spec 029: two services follow transcript files, and their names did not say
// which was which — `transcriptTailer` (PowerShell Start-Transcript) next to
// `agentTailer` (AI agents). And the Claude Code adapter lived outside
// `adapters/`, in a file that also registered the Codex and OpenCode adapters.

const root = path.join(__dirname, '..')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))

describe('tailer naming', () => {
  it('names the PowerShell follower after what it follows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tailer-naming-'))
    try {
      const c = loadConfig(dir) as unknown as Record<string, unknown>
      // Spec 035 replaced its only key with the Windows output pack.
      expect(c).toHaveProperty('packs.windowsOutput')
      expect(c).not.toHaveProperty('transcriptTailer')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    expect(exists('src/main/services/powershell-transcript.ts')).toBe(true)
    expect(exists('src/main/services/transcript-tailer.ts')).toBe(false)
  })

  it('keeps every agent adapter in adapters/, and the wiring apart from them', () => {
    for (const a of ['claude-code', 'codex', 'opencode']) {
      expect(exists(`src/main/services/adapters/${a}.ts`)).toBe(true)
    }
    expect(exists('src/main/services/agent-transcript-tailer.ts')).toBe(false)
    const wiring = fs.readFileSync(path.join(root, 'src/main/services/agent-tailer.ts'), 'utf-8')
    // The wiring registers adapters; it does not parse any agent's format.
    expect(wiring).not.toMatch(/JSON\.parse|parseTranscriptLine\s*\(/)
  })
})
