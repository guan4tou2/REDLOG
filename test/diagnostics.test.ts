import { describe, it, expect } from 'vitest'
import { scrubPath, scrubNames, buildDiagnostics, issueUrl } from '../src/renderer/src/lib/diagnostics'

// §9. A crash report's useful part is the stack, and a stack is full of
// absolute paths. On a red-team engagement those paths carry the operator's
// username and the client's name in a project folder — and the report's
// destination is a public GitHub issue that stays public. Every case here is
// something that would otherwise have been pasted into one.

describe('path scrubbing', () => {
  it('strips the user segment on all three platforms', () => {
    expect(scrubPath('/Users/jclark/notes.txt')).toBe('<user>/notes.txt')
    expect(scrubPath('/home/jclark/notes.txt')).toBe('<user>/notes.txt')
    expect(scrubPath('C:\\Users\\jclark\\notes.txt')).toBe('<user>\\notes.txt')
  })

  it('reduces a bundle path to its bundle-relative tail', () => {
    // This is the part that is actually diagnostic — where in the code it
    // broke — and it is identical on every machine.
    expect(scrubPath('/Users/jclark/Applications/RedLog.app/Contents/Resources/app.asar/out/renderer/main.js:12:5'))
      .toBe('app.asar/out/renderer/main.js:12:5')
    expect(scrubPath('C:\\Program Files\\RedLog\\resources\\app.asar\\out\\main\\index.js'))
      .toBe('app.asar\\out\\main\\index.js')
  })

  it('scrubs every path in a multi-line stack, not just the first', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at Timeline (/Users/jclark/src/redlog/Timeline.tsx:41:9)',
      '    at renderWithHooks (/Users/jclark/src/redlog/node_modules/react-dom/index.js:1:1)'
    ].join('\n')
    expect(scrubPath(stack)).not.toMatch(/jclark/)
    expect(scrubPath(stack).match(/<user>/g)).toHaveLength(2)
  })
})

describe('name scrubbing', () => {
  it('replaces the project name wherever it appears', () => {
    expect(scrubNames('opening acme-corp-q3 from /data/acme-corp-q3/events.db', { project: 'acme-corp-q3' }))
      .toBe('opening <project> from /data/<project>/events.db')
  })

  it('replaces the longer name first', () => {
    // A user called "op" inside a project called "op-falcon" must not turn
    // the project name into "<user>-falcon".
    expect(scrubNames('op-falcon', { user: 'op', project: 'op-falcon' })).toBe('<project>')
  })

  it('refuses to substitute a name too short to match safely', () => {
    // Replacing every "ab" in a stack trace destroys it and protects nothing.
    expect(scrubNames('a table of abstractions', { user: 'ab' })).toBe('a table of abstractions')
  })

  it('is a no-op when nothing was passed', () => {
    expect(scrubNames('/Users/jclark/x', {})).toBe('/Users/jclark/x')
  })
})

describe('the assembled bundle', () => {
  const built = buildDiagnostics({
    version: '0.14.3',
    platform: 'darwin',
    view: 'timeline',
    project: 'acme-corp',
    error: {
      message: 'boom',
      stack: 'Error: boom\n    at x (/Users/jclark/acme-corp/app.asar/out/renderer/main.js:9:1)'
    }
  })

  it('carries what a maintainer needs', () => {
    expect(built).toContain('RedLog 0.14.3')
    expect(built).toContain('darwin')
    expect(built).toContain('timeline')
    expect(built).toContain('Error: boom')
    expect(built).toContain('app.asar/out/renderer/main.js:9:1')
  })

  it('carries nothing that identifies the machine or the client', () => {
    expect(built).not.toMatch(/jclark/)
    expect(built).not.toMatch(/acme-corp/)
  })

  it('survives an error with no stack at all', () => {
    const b = buildDiagnostics({ version: '1', platform: 'linux', view: 'x', error: { message: 'no stack' } })
    expect(b).toContain('no stack')
  })
})

describe('issue url', () => {
  it('escapes the body rather than truncating at the first special character', () => {
    const url = issueUrl('o/r', 'crash: a&b', 'line 1\nline 2 & more')
    expect(url.startsWith('https://github.com/o/r/issues/new?')).toBe(true)
    const body = decodeURIComponent(new URL(url).searchParams.get('body') ?? '')
    expect(body).toContain('line 1\nline 2 & more')
    expect(new URL(url).searchParams.get('title')).toBe('crash: a&b')
  })
})
