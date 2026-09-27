// #218: a connected shell hook records commands, not output. The canary
// proves the output path: its output contains text its command line does not.
import { describe, it, expect } from 'vitest'
import { classifyCanaryEvent, mergeCanary, outputCanary } from '../src/renderer/src/lib/outputCanary'

const c = outputCanary('abc123')
const shell = (data: Record<string, unknown>) => ({ agentType: 'shell', data })

describe('output canary', () => {
  it('prints a marker its own command line does not contain', () => {
    expect(c.command).toBe("printf '%s-%s\\n' redlog-out abc123")
    expect(c.marker).toBe('redlog-out-abc123')
    expect(c.command.includes(c.marker)).toBe(false)
  })

  it('counts output from redlog-run and redlog-session', () => {
    expect(classifyCanaryEvent(shell({ subtype: 'command_end', command: `redlog-run ${c.command}`, stdout: 'redlog-out-abc123\n', captured_by: 'redlog-run' }), c))
      .toEqual({ kind: 'output', capturedBy: 'redlog-run' })
    expect(classifyCanaryEvent(shell({ subtype: 'session_output', stdout: `$ ${c.command}\r\nredlog-out-abc123\r\n`, captured_by: 'redlog-session' }), c))
      .toEqual({ kind: 'output', capturedBy: 'redlog-session' })
  })

  it('says only metadata arrived when the command came through the plain hook', () => {
    expect(classifyCanaryEvent(shell({ subtype: 'command_end', command: c.command, exit_code: 0 }), c)).toEqual({ kind: 'metadata-only' })
    // The PTY echo of the typed line alone is not output.
    expect(classifyCanaryEvent(shell({ subtype: 'session_output', stdout: `$ ${c.command}` }), c)).toBeNull()
    expect(classifyCanaryEvent(shell({ subtype: 'command_end', command: 'id', stdout: 'uid=0' }), c)).toBeNull()
    expect(classifyCanaryEvent({ agentType: 'scanner', data: { stdout: c.marker } }, c)).toBeNull()
  })

  it('does not let a later metadata-only row downgrade recorded output', () => {
    const out = { kind: 'output' as const, capturedBy: 'redlog-run' }
    expect(mergeCanary(out, { kind: 'metadata-only' })).toBe(out)
    expect(mergeCanary({ kind: 'metadata-only' }, out)).toBe(out)
    expect(mergeCanary(null, null)).toBeNull()
  })
})
