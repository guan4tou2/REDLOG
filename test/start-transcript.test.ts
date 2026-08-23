import { describe, it, expect } from 'vitest'
import { parseStartTranscript } from '../src/core/start-transcript'

// docs/DESIGN-core-and-capture.md §2.3. The parser must be conservative: a
// command it emits is one the operator actually typed. The tests lean on the
// failure that matters — never fabricating a command from output text.

const HEADER = [
  '**********************',
  'Windows PowerShell transcript start',
  'Start time: 20260823120000',
  'Username: DESKTOP\\redteam',
  'Machine: DESKTOP-7 (Microsoft Windows NT 10.0)',
  '**********************'
].join('\n')

const FOOTER = [
  '**********************',
  'Windows PowerShell transcript end',
  'End time: 20260823130000',
  '**********************'
].join('\n')

describe('parsing a Start-Transcript file', () => {
  it('reads the header metadata', () => {
    const t = parseStartTranscript(HEADER + '\n' + FOOTER)
    expect(t.username).toBe('DESKTOP\\redteam')
    expect(t.host).toContain('DESKTOP-7')
    expect(t.startedAtMs).toBe(Date.parse('2026-08-23T12:00:00'))
  })

  it('pairs a command with the output that follows it', () => {
    const body = [
      'PS C:\\Users\\redteam> whoami',
      'desktop\\redteam',
      'PS C:\\Users\\redteam> hostname',
      'DESKTOP-7'
    ].join('\n')
    const t = parseStartTranscript([HEADER, body, FOOTER].join('\n'))
    expect(t.commands).toHaveLength(2)
    expect(t.commands[0]).toMatchObject({ cwd: 'C:\\Users\\redteam', command: 'whoami', output: 'desktop\\redteam' })
    expect(t.commands[1]).toMatchObject({ command: 'hostname', output: 'DESKTOP-7' })
  })

  it('keeps multi-line output with its command', () => {
    const body = [
      'PS C:\\> nmap -sV 10.0.0.5',
      'Starting Nmap 7.94',
      '445/tcp open  microsoft-ds',
      '3389/tcp open  ms-wbt-server'
    ].join('\n')
    const t = parseStartTranscript([HEADER, body, FOOTER].join('\n'))
    expect(t.commands).toHaveLength(1)
    expect(t.commands[0].command).toBe('nmap -sV 10.0.0.5')
    expect(t.commands[0].output).toContain('445/tcp open')
    expect(t.commands[0].output).toContain('ms-wbt-server')
  })

  it('never turns output into a command — the anti-fabrication guard', () => {
    // Output that merely mentions "PS" or contains a > must not be read as a
    // prompt. Only a real `PS <path>> ` line is a command.
    const body = [
      'PS C:\\> type notes.txt',
      'remember to run PS scripts later',
      'echo foo > out.txt is just text here'
    ].join('\n')
    const t = parseStartTranscript([HEADER, body, FOOTER].join('\n'))
    expect(t.commands).toHaveLength(1)
    expect(t.commands[0].command).toBe('type notes.txt')
    expect(t.commands[0].output).toContain('remember to run PS scripts later')
  })

  it('skips an empty prompt (operator just pressed Enter)', () => {
    const body = ['PS C:\\> ', 'PS C:\\> whoami', 'desktop\\x'].join('\n')
    const t = parseStartTranscript([HEADER, body, FOOTER].join('\n'))
    expect(t.commands).toHaveLength(1)
    expect(t.commands[0].command).toBe('whoami')
  })

  it('drops the header/footer banners rather than treating them as output', () => {
    const body = 'PS C:\\> whoami\ndesktop\\x'
    const t = parseStartTranscript([HEADER, body, FOOTER].join('\n'))
    expect(t.commands[0].output).toBe('desktop\\x')
    expect(t.commands[0].output).not.toContain('transcript end')
  })

  it('handles a CRLF transcript (the native Windows line ending)', () => {
    // A genuine CRLF file: join with \r\n rather than converting an existing
    // \r\n again (which would produce \r\r\n and is a different test).
    const body = 'PS C:\\> whoami\ndesktop\\x'
    const t = parseStartTranscript([HEADER, body, FOOTER].join('\n').replace(/\n/g, '\r\n'))
    expect(t.commands).toHaveLength(1)
    expect(t.commands[0].command).toBe('whoami')
    expect(t.commands[0].output).toBe('desktop\\x')
  })

  it('tolerates a truncated transcript with no footer (a crash mid-session)', () => {
    const body = 'PS C:\\> nmap -sV 10.0.0.5\nStarting Nmap'
    const t = parseStartTranscript([HEADER, body].join('\n'))
    expect(t.commands).toHaveLength(1)
    expect(t.commands[0].output).toBe('Starting Nmap')
  })

  it('returns nothing usable for a file that is not a transcript', () => {
    const t = parseStartTranscript('just some random text\nwith no prompts')
    expect(t.commands).toEqual([])
    expect(t.startedAtMs).toBeNull()
  })
})
