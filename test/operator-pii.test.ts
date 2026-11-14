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

// Third review of FR-097: the patterns above are linear on any text, they do
// not scrub what is not the operator's, and the over-scrubs that remain are
// the deliberate ones named in src/core/operator-pii.ts.
describe('operator PII: linear time, and nothing scrubbed that is not the operator\'s', () => {
  const MB20 = 20 * 1024 * 1024
  const HOMES: Array<[string, { home: string; user: string; host: string }]> = [
    ['Windows', { home: 'C:\\Users\\joanne', user: 'joanne', host: 'nope-host' }],
    ['UNC', { home: '\\\\srv\\share\\jo', user: 'jo', host: 'nope-host' }],
    ['a home holding a quote', { home: '/home/o"neil', user: 'oneil', host: 'nope-host' }],
    ['a home holding a backslash and a quote', { home: '/home/a\\"b', user: 'nope', host: 'nope-host' }],
    ['POSIX', { home: '/home/alice', user: 'alice', host: 'nope-host' }]
  ]
  const TEXTS: Array<[string, string]> = [
    ['backslashes', '\\'.repeat(MB20)],
    ['\\"', '\\"'.repeat(MB20 / 2)],
    ['alternating \\ and \\"', '\\\\"'.repeat(Math.floor(MB20 / 3))]
  ]

  for (const [label, ids] of HOMES) {
    it(`${label}: 20 MB of backslashes, of \\", and of both alternating, each scanned in well under a second`, () => {
      const reps = operatorPiiReplacements(ids)
      for (const [name, text] of TEXTS) {
        const t0 = performance.now()
        const out = scrubOperatorPii(text, reps)
        const ms = performance.now() - t0
        expect(out.length, name).toBe(text.length)
        // Measured at ~10–60 ms each (2026-11-14); a quadratic pattern takes
        // minutes on a run this long.
        expect(ms, `${label} / ${name}: ${Math.round(ms)} ms`).toBeLessThan(2_000)
      }
    })
  }

  it('the UNC home is still found at every level of escaping, including after a longer run of backslashes', () => {
    const reps = operatorPiiReplacements({ home: '\\\\srv\\share\\jo', user: 'jo', host: 'nope-host' })
    for (const levels of [0, 1, 2, 3]) {
      let text = '\\\\srv\\share\\jo\\notes'
      for (let i = 0; i < levels; i++) text = JSON.stringify(text)
      expect(scrubOperatorPii(text, reps), String(levels)).not.toMatch(/srv/)
    }
  })

  it('the home path ends where a path segment ends: `C:\\Users\\Jo` is not the start of `C:\\Users\\Joanna`', () => {
    const reps = operatorPiiReplacements({ home: 'C:\\Users\\Jo', user: 'jo', host: 'nope-host' })
    for (const levels of [0, 1, 2]) {
      let text = 'C:\\Users\\Joanna\\x and C:\\Users\\Jo\\y and C:\\Users\\Jo'
      for (let i = 0; i < levels; i++) text = JSON.stringify(text)
      const out = scrubOperatorPii(text, reps)
      expect(out, String(levels)).toContain('Joanna')
      expect(out, String(levels)).not.toContain('<home>anna')
      expect(out.match(/<home>/g), String(levels)).toHaveLength(2)
    }
  })

  it('a user name is not scrubbed inside a longer word, at any level, and text beside it is kept', () => {
    const reps = operatorPiiReplacements({ home: '/nope', user: 'alice', host: 'nope-host' })
    for (const levels of [0, 1, 2]) {
      let text = 'malice aliceb alice_x xalice "alice" alice\\nbob'
      for (let i = 0; i < levels; i++) text = JSON.stringify(text)
      const out = scrubOperatorPii(text, reps)
      for (const kept of ['malice', 'aliceb', 'alice_x', 'xalice']) expect(out, `${levels} ${kept}`).toContain(kept)
      expect(out.match(/<user>/g), String(levels)).toHaveLength(2)
      // A lazy any-character run between the pieces would swallow the text
      // between two mentions; nothing of it goes.
      expect(out.replace(/<user>/g, 'alice'), String(levels)).toBe(text)
    }
  })

  it('the deliberate over-scrubs: an escape letter before the name, and a name inside a run of CJK', () => {
    const reps = operatorPiiReplacements({ home: '/nope', user: 'alice', host: 'nope-host' })
    expect(scrubOperatorPii(JSON.stringify('C:\\nalice'), reps)).toBe(JSON.stringify('C:\\n').slice(0, -1) + '<user>"')
    const cjk = operatorPiiReplacements({ home: '/nope', user: '王小明', host: 'nope-host' })
    expect(scrubOperatorPii('他說王小明天要來', cjk)).toBe('他說<user>天要來')
  })
})
