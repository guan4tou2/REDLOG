import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// #345. The hook used to hand curl `--data-binary @<path>`. On Windows a native
// curl resolves that path itself, and with MSYS_NO_PATHCONV=1 (or an
// MSYS2_ARG_CONV_EXCL covering "@") it cannot resolve the MSYS path the hook
// just built, so the POST failed and every event went to the spool instead —
// ~30s late, or never if nothing drains that spool.
//
// The fix is that bash opens the file and the body travels on stdin, so the
// path never reaches curl's argv at all. That is the property asserted here:
// not "a payload arrived", which was already true, but "no path was passed to
// curl", which is what the Windows failure needed.
//
// This runs a real bash with a curl shim on PATH, so it is POSIX by
// construction. It cannot reproduce MSYS path conversion on macOS or Linux;
// it pins the argv shape that makes the conversion irrelevant.
describe.skipIf(process.platform === 'win32')('#345 hook payload delivery', () => {
  it('passes the body on stdin and never puts a payload path in curl argv', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stdin-'))
    tempDirs.push(home)
    const redlogDir = path.join(home, '.redlog')
    const binDir = path.join(home, 'bin')
    const argvFile = path.join(home, 'argv.txt')
    const bodyFile = path.join(home, 'body.txt')
    fs.mkdirSync(redlogDir)
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(redlogDir, 'api-port'), '6660')
    fs.writeFileSync(path.join(redlogDir, 'api-token'), 'test-token')

    // Records the argv of the POST only; the reachability probe is a different
    // call and would otherwise add a line with no --data-binary in it.
    const curl = path.join(binDir, 'curl')
    fs.writeFileSync(curl, `#!/bin/sh
data=0
for a in "$@"; do
  [ "$a" = "--data-binary" ] && data=1
done
if [ "$data" = "1" ]; then
  printf '%s|' "$@" >> "$REDLOG_TEST_ARGV"
  printf '\\n' >> "$REDLOG_TEST_ARGV"
  cat >> "$REDLOG_TEST_BODY"
  printf '\\n' >> "$REDLOG_TEST_BODY"
fi
exit 0
`)
    fs.chmodSync(curl, 0o755)

    const hook = path.resolve('hooks/shell-bash-hook.sh')
    const result = spawnSync('bash', ['-c', `source "$1" >/dev/null
redlog-run sh -c 'printf STDIN_OK'
`, 'bash', hook], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        REDLOG_TEST_ARGV: argvFile,
        REDLOG_TEST_BODY: bodyFile
      },
      encoding: 'utf8',
      timeout: 20_000
    })

    expect(result.stderr).not.toContain('command not found')
    const calls = fs.readFileSync(argvFile, 'utf8').trim().split('\n')
      .map((line) => line.split('|').filter((arg) => arg.length > 0))
    expect(calls.length).toBeGreaterThan(0)

    for (const args of calls) {
      const at = args.indexOf('--data-binary')
      expect(at).toBeGreaterThanOrEqual(0)
      // The value is stdin, not a file: `@-`.
      expect(args[at + 1]).toBe('@-')
      // And no argument carries a filesystem path for curl to resolve.
      expect(args.some((arg) => arg.includes('payload.json'))).toBe(false)
      expect(args.some((arg) => /^@\//.test(arg))).toBe(false)
      expect(args.some((arg) => /^@[A-Za-z]:/.test(arg))).toBe(false)
    }

    const bodies = fs.readFileSync(bodyFile, 'utf8').trim().split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
    // The body really travelled through stdin: it is the event, not an empty
    // stream that happened to satisfy the argv check.
    expect(bodies.some((body) => String(body.data?.command ?? '').includes('STDIN_OK'))).toBe(true)
    expect(bodies.some((body) => body.data?.subtype === 'command_end')).toBe(true)
  }, 30_000)
})
