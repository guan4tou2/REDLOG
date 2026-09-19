import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scrubCast } from '../src/core/bundle-export'

let tmpDir: string

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrubcast-'))
  return tmpDir
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('scrubCast', () => {
  it('replaces PII that straddles a chunk boundary', () => {
    const dir = setup()
    const header = JSON.stringify({ version: 2, width: 80, height: 24, env: {} })
    const secret = '/Users/guantou'
    const padding = 'A'.repeat(32 - secret.length)
    const line1 = JSON.stringify([0.1, 'o', padding + secret])
    const src = path.join(dir, 'input.cast')
    const dst = path.join(dir, 'output.cast')
    fs.writeFileSync(src, header + '\n' + line1 + '\n')

    const chunkSize = header.length + 1 + padding.length + 10
    const reps: Array<[RegExp, string]> = [[/\/Users\/guantou/g, '[HOME]']]
    scrubCast(src, dst, reps, chunkSize)

    const result = fs.readFileSync(dst, 'utf-8')
    expect(result).not.toContain('/Users/guantou')
    expect(result).toContain('[HOME]')
  })

  it('handles empty reps by copying', () => {
    const dir = setup()
    const content = '{"version":2}\n[0.1,"o","hello"]\n'
    const src = path.join(dir, 'input.cast')
    const dst = path.join(dir, 'output.cast')
    fs.writeFileSync(src, content)
    scrubCast(src, dst, [])
    expect(fs.readFileSync(dst, 'utf-8')).toBe(content)
  })

  it('scrubs header env values', () => {
    const dir = setup()
    const header = JSON.stringify({ version: 2, width: 80, height: 24, env: { USER: 'guantou', HOME: '/Users/guantou' } })
    const body = '[0.1,"o","$ ls"]\n'
    const src = path.join(dir, 'input.cast')
    const dst = path.join(dir, 'output.cast')
    fs.writeFileSync(src, header + '\n' + body)

    scrubCast(src, dst, [[/\/Users\/guantou/g, '[HOME]'], [/guantou/g, '[REDACTED]']])
    const result = fs.readFileSync(dst, 'utf-8')
    const parsedHeader = JSON.parse(result.split('\n')[0])
    expect(parsedHeader.env.USER).toBe('[REDACTED]')
    expect(parsedHeader.env.HOME).toBe('[HOME]')
  })

  it('handles empty file', () => {
    const dir = setup()
    const src = path.join(dir, 'input.cast')
    const dst = path.join(dir, 'output.cast')
    fs.writeFileSync(src, '')
    scrubCast(src, dst, [[/secret/g, '[X]']])
    expect(fs.readFileSync(dst, 'utf-8')).toBe('')
  })

  it('preserves line count and structure', () => {
    const dir = setup()
    const header = JSON.stringify({ version: 2, width: 80, height: 24 })
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify([i * 0.01, 'o', `line${i} secret_value here`])
    )
    const src = path.join(dir, 'input.cast')
    const dst = path.join(dir, 'output.cast')
    fs.writeFileSync(src, header + '\n' + lines.join('\n') + '\n')

    scrubCast(src, dst, [[/secret_value/g, '[SCRUBBED]']], 128)
    const result = fs.readFileSync(dst, 'utf-8')
    const resultLines = result.trimEnd().split('\n')
    expect(resultLines.length).toBe(101)
    expect(result).not.toContain('secret_value')
    expect(result).toContain('[SCRUBBED]')
  })
})
