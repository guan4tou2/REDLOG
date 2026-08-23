import { describe, it, expect } from 'vitest'
import { planTranscriptEmit } from '../src/main/services/transcript-tailer'

// The follower re-parses the whole transcript on each change; the only logic
// that can go wrong is "which commands are new". A bug here re-emits a command
// the operator already has (a duplicate on the timeline) or skips one (a gap in
// the record) — both worse than not capturing at all, so this is where the test
// weight goes. The parser itself is covered by start-transcript.test.ts.

const HEADER = [
  '**********************',
  'Windows PowerShell transcript start',
  'Start time: 20260823120000',
  'Machine: DESKTOP-7',
  '**********************'
].join('\n')

const cmd = (c: string, out = ''): string => `PS C:\\> ${c}${out ? '\n' + out : ''}`

describe('incremental transcript emit', () => {
  it('emits every command the first time it sees a transcript', () => {
    const text = [HEADER, cmd('whoami', 'desktop\\x'), cmd('hostname', 'DESKTOP-7')].join('\n')
    const { fresh, newCount } = planTranscriptEmit(text, 0)
    expect(fresh.map((c) => c.command)).toEqual(['whoami', 'hostname'])
    expect(newCount).toBe(2)
  })

  it('emits only the commands appended since the last read', () => {
    const first = [HEADER, cmd('whoami', 'x')].join('\n')
    const grown = [HEADER, cmd('whoami', 'x'), cmd('nmap -sV 10.0.0.5', 'open')].join('\n')
    const after = planTranscriptEmit(first, 0).newCount
    const { fresh } = planTranscriptEmit(grown, after)
    expect(fresh.map((c) => c.command)).toEqual(['nmap -sV 10.0.0.5'])
  })

  it('emits nothing when the file changed but no new command landed', () => {
    // A transcript's last command output can keep growing after the command;
    // a change event then fires with the same command count. It must not
    // re-emit the command.
    const text = [HEADER, cmd('long-running', 'line1')].join('\n')
    const grownOutput = [HEADER, cmd('long-running', 'line1\nline2\nline3')].join('\n')
    const after = planTranscriptEmit(text, 0).newCount
    const { fresh } = planTranscriptEmit(grownOutput, after)
    expect(fresh).toEqual([])
  })

  it('carries the command output through', () => {
    const text = [HEADER, cmd('nmap -sV 10.0.0.5', '445/tcp open  microsoft-ds')].join('\n')
    const { fresh } = planTranscriptEmit(text, 0)
    expect(fresh[0].output).toContain('445/tcp open')
  })

  it('is a no-op on an empty transcript', () => {
    const { fresh, newCount } = planTranscriptEmit(HEADER, 0)
    expect(fresh).toEqual([])
    expect(newCount).toBe(0)
  })
})
