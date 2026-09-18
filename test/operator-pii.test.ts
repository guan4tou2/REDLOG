import { describe, it, expect } from 'vitest'
import { operatorPiiReplacements, scrubOperatorPii } from '../src/core/operator-pii'

describe('operatorPiiReplacements', () => {
  it('replaces the home path with <home>', () => {
    const reps = operatorPiiReplacements({ home: '/Users/alice', user: 'alice', host: 'box' })
    const out = scrubOperatorPii('/Users/alice/.config/redlog', reps)
    expect(out).toBe('<home>/.config/redlog')
  })

  it('replaces the hostname with <host>', () => {
    const reps = operatorPiiReplacements({ home: '/nope', user: 'nope', host: 'devbox-42' })
    const out = scrubOperatorPii('connected to devbox-42 via ssh', reps)
    expect(out).toBe('connected to <host> via ssh')
  })

  it('replaces the username with <user> (word-boundary aware)', () => {
    const reps = operatorPiiReplacements({ home: '/nope', user: 'alice', host: 'nope' })
    // "alice" standalone should be replaced; "malice" should NOT
    const out = scrubOperatorPii('alice logged in, not malice', reps)
    expect(out).toBe('<user> logged in, not malice')
  })

  it('skips usernames shorter than 3 characters', () => {
    const reps = operatorPiiReplacements({ home: '/nope', user: 'ab', host: 'nope' })
    const out = scrubOperatorPii('user ab was here', reps)
    expect(out).toBe('user ab was here')
  })

  it('replaces backslash-escaped Windows paths', () => {
    const reps = operatorPiiReplacements({ home: 'C:\\Users\\alice', user: 'nope', host: 'nope' })
    // Double-backslash form that appears in JSON-serialized strings
    const out = scrubOperatorPii('path is C:\\\\Users\\\\alice\\\\.config', reps)
    expect(out).toBe('path is <home>\\\\.config')
  })

  it('replaces multiple occurrences (global flag)', () => {
    const reps = operatorPiiReplacements({ home: '/home/ops', user: 'ops', host: 'srv' })
    const out = scrubOperatorPii('ops@srv:/home/ops ops@srv:/home/ops', reps)
    expect(out).toBe('<user>@<host>:<home> <user>@<host>:<home>')
  })
})

describe('scrubOperatorPii convenience wrapper', () => {
  it('builds replacements internally when none are supplied', () => {
    // We can't predict the real OS values, but we CAN verify the function
    // runs without throwing and returns a string.
    const result = scrubOperatorPii('some arbitrary text')
    expect(typeof result).toBe('string')
  })

  it('returns text unchanged when it contains no PII tokens', () => {
    const reps = operatorPiiReplacements({ home: '/home/ops', user: 'ops', host: 'srv' })
    const text = 'nothing sensitive here at all'
    expect(scrubOperatorPii(text, reps)).toBe(text)
  })
})
