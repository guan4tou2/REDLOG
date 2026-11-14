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

// Spec 071 FR-097 put whole containers inside strings (the `_collapsed`
// wrapper), so a home path can now sit one escaping level deeper than any
// field held it before: `C:\Users\Jo` reads `C:\\\\Users\\\\Jo` in the
// exported text, and a body holding JSON text inside that, deeper still. The
// scrub matches every escaping level.
import { boundDataDepth } from '../src/core/ingest/depth'

describe('operator PII at every level of JSON escaping (FR-097)', () => {
  const nest = (levels: number, leaf: unknown): unknown => { let v = leaf; for (let i = 0; i < levels; i++) v = [v]; return v }
  /** The exported text of a row whose `data.deep` holds `leaf` under `levels` arrays. */
  const exported = (levels: number, leaf: unknown): string => JSON.stringify(boundDataDepth({ subtype: 'x', deep: nest(levels, leaf) }).data)
  const WIN = { home: 'C:\\Users\\Jo', user: 'jo', host: 'nope-host' }
  const winPath = 'C:\\Users\\Jo\\Desktop\\client-x\\notes.txt'

  it('a Windows home under 60 levels (one escaping) and under 70 (inside a wrapper, two) is scrubbed, its separators kept', () => {
    const reps = operatorPiiReplacements(WIN)
    const shallow = scrubOperatorPii(exported(60, { p: winPath }), reps)
    expect(shallow).not.toMatch(/Users/)
    expect(shallow).toMatch(/<home>\\{2}Desktop\\{2}client-x/)
    const deep = exported(70, { p: winPath })
    expect(deep).toContain('C:\\\\\\\\Users\\\\\\\\Jo')
    const scrubbed = scrubOperatorPii(deep, reps)
    expect(scrubbed).not.toMatch(/Users/)
    expect(scrubbed).toMatch(/<home>\\{4}Desktop\\{4}client-x/)
  })

  it('three levels: a string holding JSON text inside a wrapper', () => {
    const text = exported(70, { body: JSON.stringify({ p: winPath }) })
    expect(text).toContain('C:\\\\\\\\\\\\\\\\Users')
    const scrubbed = scrubOperatorPii(text, operatorPiiReplacements(WIN))
    expect(scrubbed).not.toMatch(/Users/)
    expect(scrubbed).toMatch(/<home>\\{8}Desktop/)
  })

  it('a POSIX home inside a wrapper, and one holding a quote', () => {
    const reps = operatorPiiReplacements({ home: '/home/alice', user: 'alice', host: 'nope-host' })
    expect(scrubOperatorPii(exported(70, ['/home/alice/notes', 'alice ran it']), reps)).not.toMatch(/alice/)
    const quoted = operatorPiiReplacements({ home: '/home/we"ird', user: 'nope', host: 'nope-host' })
    for (const levels of [0, 60, 70]) {
      const text = scrubOperatorPii(exported(levels, ['/home/we"ird/x']), quoted)
      expect(text, String(levels)).not.toMatch(/we\\*"ird/)
      expect(text, String(levels)).toContain('<home>/x')
    }
  })

  it('a home folder named apart from the user (`jsmith.CORP`), and the user name after an escape sequence', () => {
    const reps = operatorPiiReplacements({ home: 'C:\\Users\\jsmith.CORP', user: 'jsmith', host: 'nope-host' })
    const text = scrubOperatorPii(exported(70, ['C:\\Users\\jsmith.CORP\\a', 'whoami\njsmith', 'by jsmith.']), reps)
    expect(text).not.toMatch(/jsmith/)
    expect(text).toMatch(/<home>\\{4}a/)
  })

  it('a user name shorter than 3 characters is still not scrubbed on its own; the home that holds it is', () => {
    const text = scrubOperatorPii(exported(70, [winPath, 'jo said']), operatorPiiReplacements(WIN))
    expect(text).not.toMatch(/Users/)
    expect(text).toContain('jo said')
  })
})
