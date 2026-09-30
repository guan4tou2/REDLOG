// The redlog-pentest skill instructs the agent to call redlog_* tools by name.
// Those names have to resolve to a real tool definition, or the agent's first
// turn fails silently. redlog_session_register shipped only as an MCP tool;
// when the MCP server was removed (#87), the tool went with it but the skill
// kept referencing it — the agent's mandated first call (#241) had nothing to
// bind to. These pin the skill's tool names to the surfaces that expose them.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const codexTools = JSON.parse(read('docs/codex-tools.json')) as {
  tools: { function: { name: string; parameters?: { required?: string[] } } }[]
}
const codexNames = new Set(codexTools.tools.map((t) => t.function.name))

const skill = read('docs/skills/redlog-pentest.md')
const skillToolNames = [...new Set(skill.match(/redlog_[a-z_]+/g) ?? [])]

describe('agent tool surface covers the skill', () => {
  it('every redlog_* tool the skill tells the agent to call is defined in codex-tools.json', () => {
    const missing = skillToolNames.filter((name) => !codexNames.has(name))
    expect(missing).toEqual([])
  })

  it('redlog_session_register — the mandated first call — is exposed as an agent tool', () => {
    expect(codexNames.has('redlog_session_register')).toBe(true)
    const def = codexTools.tools.find((t) => t.function.name === 'redlog_session_register')
    expect(def?.function.parameters?.required).toContain('session_id')
  })

  it('redlog_session_register is also a shell helper function', () => {
    expect(read('shell/redlog-agent.sh')).toMatch(/^redlog_session_register\(\)/m)
  })
})
