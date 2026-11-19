// These function-call schemas need a consumer-supplied HTTP adapter.
// The server contract is checked by agent-api-contract.test.ts.
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

describe('function schema examples cover the skill notation', () => {
  it('every redlog_* name used by the skill has a function schema', () => {
    const missing = skillToolNames.filter((name) => !codexNames.has(name))
    expect(missing).toEqual([])
  })

  it('the registration schema retains its required session ID', () => {
    expect(codexNames.has('redlog_session_register')).toBe(true)
    const def = codexTools.tools.find((t) => t.function.name === 'redlog_session_register')
    expect(def?.function.parameters?.required).toContain('session_id')
  })

  it('redlog_session_register is also a shell helper function', () => {
    expect(read('shell/redlog-agent.sh')).toMatch(/^redlog_session_register\(\)/m)
  })
})
