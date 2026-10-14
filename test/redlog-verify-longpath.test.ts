import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

// #258. On Windows without long-path support a path past 260 characters makes
// `Path.exists()` answer False for a file that is there, so the verifier
// reported every cast and screenshot of a bundle in a deep evidence folder as
// "missing" (or the bundle itself as "does not exist"). The fix is to open the
// bundle by its extended-length (`\\?\`) path. This file does not need the
// database, only a Python that runs.

const verifier = path.resolve(__dirname, '..', 'tools', 'redlog-verify.py')
const SPAWN_MS = 15_000

function findPython(): string | null {
  const loc = process.env.pythonLocation
  return [
    ...(loc ? [path.join(loc, 'python.exe'), path.join(loc, 'bin', 'python3')] : []),
    'python3', 'python'
  ].find((exe) => {
    const probe = spawnSync(exe, ['-c', 'print(1)'], { encoding: 'utf-8', timeout: SPAWN_MS })
    return !probe.error && probe.status === 0 && probe.stdout.trim() === '1'
  }) ?? null
}
const python = findPython()
const describePy = python ? describe : describe.skip

const tempDirs: string[] = []
afterEach(() => {
  // The tree is deeper than MAX_PATH, so removing it needs the extended form too.
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(process.platform === 'win32' ? `\\\\?\\${dir}` : dir, { recursive: true, force: true })
  }
})

/** What the verifier makes of a path — evaluated with `windows` forced, so the
 *  rule is checked on every platform and not only where it matters. */
function extended(p: string, windows: boolean): string {
  const code = [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location('v', ${JSON.stringify(verifier)})`,
    'v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)',
    `sys.stdout.write(v._extended_length(${JSON.stringify(p)}, ${windows ? 'True' : 'False'}))`
  ].join('\n')
  const r = spawnSync(python!, ['-c', code], { encoding: 'utf-8', timeout: SPAWN_MS })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout
}

describePy('the verifier and paths past MAX_PATH (#258)', () => {
  it('prefixes a Windows path, a UNC path once, and leaves everything else alone', () => {
    expect(extended('C:\\a\\b', true)).toBe('\\\\?\\C:\\a\\b')
    expect(extended('\\\\server\\share\\a', true)).toBe('\\\\?\\UNC\\server\\share\\a')
    expect(extended('\\\\?\\C:\\a\\b', true)).toBe('\\\\?\\C:\\a\\b')
    expect(extended('/home/u/bundle', false)).toBe('/home/u/bundle')
  })

  // Only Windows has the limit, so only there can the failure be reproduced;
  // elsewhere the same bundle verifies regardless, which is the point of the
  // fix being a no-op there.
  it('verifies a bundle that sits deeper than 260 characters', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'r258-'))
    tempDirs.push(base)
    let deep = base
    while (deep.length < 290) deep = path.join(deep, 'evidence-folder-name')
    // Created through the extended form: the plain one is what fails.
    const make = process.platform === 'win32' ? `\\\\?\\${deep}` : deep
    fs.mkdirSync(path.join(make, 'casts'), { recursive: true })
    const cast = Buffer.from('cast-bytes')
    fs.writeFileSync(path.join(make, 'casts', 'a.cast'), cast)
    fs.writeFileSync(path.join(make, 'events.jsonl'), '')
    fs.writeFileSync(path.join(make, 'manifest.json'), JSON.stringify({
      bundleVersion: 3, chainHead: null, eventCount: 0,
      files: [{ path: 'casts/a.cast', sha256: crypto.createHash('sha256').update(cast).digest('hex') }]
    }))

    fs.writeFileSync(path.join(make, 'manifest.sha256'), crypto.createHash('sha256').update(fs.readFileSync(path.join(make, 'manifest.json'))).digest('hex'))

    expect(deep.length).toBeGreaterThan(260)
    const r = spawnSync(python!, [verifier, deep], { encoding: 'utf-8', timeout: SPAWN_MS })
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Manifest files\s+:\s+1 verified/)
  }, 30_000)
})
