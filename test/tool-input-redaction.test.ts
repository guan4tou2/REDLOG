import { describe, it, expect } from 'vitest'
import { redactToolInput, deepRedactStrings } from '../src/main/services/tailer-host'

// v0.12.2: per-tool "which fields need scanning" allowlist. Before this,
// deepRedactStrings walked the full tool_input tree on every turn. These
// tests lock the contract: known-clean tools skip the scan entirely,
// known-freetext tools scan only listed fields, unknown tools fall back
// to full-tree scan (safe default).

describe('redactToolInput — per-tool allowlist', () => {
  it('Read (known-clean): no scan; every field passes through untouched', () => {
    const input = {
      file_path: '/home/user/.ssh/id_rsa',  // path with secret-shaped substring; must NOT trigger
      offset: 0,
      limit: 100
    }
    const out = redactToolInput('Read', input)
    // file_path stays as-is even though it looks suspicious — Read
    // reads a path, it doesn't leak the file's contents to tool_input.
    expect(out.file_path).toBe('/home/user/.ssh/id_rsa')
    expect(out.offset).toBe(0)
    expect(out.limit).toBe(100)
  })

  it('Bash (known-freetext): command scanned; other fields (if any) passthrough', () => {
    const input = {
      command: 'export API_KEY=abc123 && curl example.com',
      description: 'set env and curl',  // not in allowlist for Bash
      timeout: 30000
    }
    const out = redactToolInput('Bash', input)
    expect(out.command).toContain('[REDACTED]')
    // description is not scanned even though it's a string — Bash's
    // allowlist is `{command}` only. This is the optimisation. A future
    // tightening could add description too, at the cost of the scan.
    expect(out.description).toBe('set env and curl')
    expect(out.timeout).toBe(30000)
  })

  it('Edit: both old_string and new_string scanned', () => {
    const input = {
      file_path: '/repo/.env',
      old_string: 'API_KEY=old_secret_1234',
      new_string: 'API_KEY=new_secret_5678'
    }
    const out = redactToolInput('Edit', input)
    expect(out.old_string).toContain('[REDACTED]')
    expect(out.new_string).toContain('[REDACTED]')
    expect(out.file_path).toBe('/repo/.env')  // not in allowlist
  })

  it('unknown tool: falls back to full-tree scan (safe default)', () => {
    const input = {
      random_field: 'password=hunter2xxx',
      nested: { another: 'AKIAIOSFODNN7EXAMPLE' }
    }
    const out = redactToolInput('mcp__weird__probe', input)
    expect(out.random_field).toContain('[REDACTED]')
    expect((out.nested as { another: string }).another).toContain('[AWS_KEY_REDACTED]')
  })

  it('undefined toolName: falls back to full-tree scan', () => {
    const out = redactToolInput(undefined, { arbitrary: 'ghp_1234567890abcdefghij1234567890abcdef' })
    expect(out.arbitrary).toContain('[GITHUB_TOKEN_REDACTED]')
  })

  it('empty allowlist tool: returns shallow copy (not the same reference)', () => {
    const input = { file_path: '/some/path' }
    const out = redactToolInput('Read', input)
    expect(out).toEqual(input)
    expect(out).not.toBe(input)  // shallow copy — downstream mutations don't touch the adapter's parsed turn
  })

  it('WebFetch: prompt scanned, url passthrough', () => {
    const input = {
      url: 'https://api.example.com/?token=abc123',  // URL might carry a token but the URL field isn't in the scan set
      prompt: 'summarise this doc password=hunter2xxx'
    }
    const out = redactToolInput('WebFetch', input)
    expect(out.prompt).toContain('[REDACTED]')
    // The audit trade-off: URL isn't scanned. In practice URLs with tokens
    // land in scanner.http_request_start where the full redaction pass
    // runs; the tailer sees only what Claude passed to WebFetch, which
    // for real secrets is caught upstream.
    expect(out.url).toBe('https://api.example.com/?token=abc123')
  })
})

describe('deepRedactStrings (unchanged fallback)', () => {
  it('walks nested objects + arrays', () => {
    const input = {
      arr: ['plain', 'password=hunter2xxx'],
      nested: { k: 'AKIAIOSFODNN7EXAMPLE' }
    }
    const out = deepRedactStrings(input) as typeof input
    expect(out.arr[1]).toContain('[REDACTED]')
    expect(out.nested.k).toContain('[AWS_KEY_REDACTED]')
    // Non-strings unchanged.
    expect(out.arr[0]).toBe('plain')
  })

  it('cycle-safe (marks second visit as [cyclic])', () => {
    const a: Record<string, unknown> = { name: 'a' }
    const b: Record<string, unknown> = { name: 'b', ref: a }
    a.ref = b
    const out = deepRedactStrings(a) as Record<string, unknown>
    // Somewhere in the walk we hit a repeat and marked it.
    const flat = JSON.stringify(out)
    expect(flat).toContain('[cyclic]')
  })
})
