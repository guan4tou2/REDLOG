// Source, scripts and shell hooks must be LF on every checkout. .gitattributes
// pins them; this checks the working tree actually has them that way. It runs
// on the Windows leg, where core.autocrlf=true would otherwise turn every .ts,
// .mjs and .ps1 into CRLF (a `#!` line in a CRLF .mjs broke an ESM import once,
// ca87f903). A failure here on Windows means .gitattributes lost a pattern; on
// any OS it means a CRLF file was committed (`git add --renormalize .` fixes
// the index once the attribute is right).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..')
const LF_ONLY = ['ts', 'tsx', 'mts', 'js', 'cjs', 'mjs', 'ps1', 'sh', 'zsh', 'bash', 'py', 'svg']

/** True when the bytes are text (no NUL) and contain a CR LF pair. */
function hasCrlf(buf: Buffer): boolean {
  return !buf.includes(0) && buf.includes('\r\n')
}

describe('line endings', () => {
  it('the check catches CRLF and passes LF and binary', () => {
    expect(hasCrlf(Buffer.from('#!/usr/bin/env node\r\nimport x from "y"\r\n'))).toBe(true)
    expect(hasCrlf(Buffer.from('#!/usr/bin/env node\nimport x from "y"\n'))).toBe(false)
    expect(hasCrlf(Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a]))).toBe(false)
  })

  it('every tracked source, script and hook file is LF in this checkout', () => {
    const r = spawnSync('git', ['ls-files', '-z', '--', ...LF_ONLY.map((e) => `*.${e}`)], { cwd: ROOT, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const files = r.stdout.split('\0').filter(Boolean)
    expect(files.length).toBeGreaterThan(1000)
    const crlf = files.filter((f) => fs.existsSync(path.join(ROOT, f)) && hasCrlf(fs.readFileSync(path.join(ROOT, f))))
    expect(crlf, `CRLF in ${crlf.length} file(s); check .gitattributes covers their extension:\n${crlf.slice(0, 20).join('\n')}`).toEqual([])
  })
})
