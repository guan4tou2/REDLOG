import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// pwsh is not available on the dev/CI Linux and macOS runners, so this scans
// the source: the spool function must refuse to write without an engagement.
describe('shell-hook.ps1 spool needs an open project', () => {
  const src = readFileSync(join(__dirname, '..', 'hooks', 'shell-hook.ps1'), 'utf8')
  const fn = src.slice(src.indexOf('function _RedLogSpoolPayload'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))

  it('returns before creating the spool dir when no engagementId is on disk', () => {
    const gate = body.indexOf('"engagementId"')
    const mkdir = body.indexOf('New-Item')
    expect(gate).toBeGreaterThan(-1)
    expect(mkdir).toBeGreaterThan(gate)
    expect(body.slice(0, mkdir)).toMatch(/\{ return \}/)
  })
})
