import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// python3 and curl are not optional on POSIX. The shell adapter builds every
// event with python3 and posts it with curl, and the BUILT-IN terminal sources
// that same adapter — so without them a Kali install opens, records the screen,
// and puts no command on the Timeline, which the first-run screen cannot tell
// apart from an operator who has not typed anything yet.
//
// `deb.depends` REPLACES electron-builder's default list rather than extending
// it, so dropping the Electron runtime's own libraries while adding ours would
// produce a package that installs and cannot start.
const YML = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf-8')

const depends = (): string[] => {
  const start = YML.indexOf('  depends:')
  expect(start, 'deb.depends is not declared').toBeGreaterThan(-1)
  const rest = YML.slice(start).split('\n').slice(1)
  const out: string[] = []
  for (const line of rest) {
    const m = /^\s{4}- (\S+)/.exec(line)
    if (!m) break
    out.push(m[1])
  }
  return out
}

describe('the .deb declares what command capture needs', () => {
  it('depends on python3 and curl', () => {
    expect(depends()).toEqual(expect.arrayContaining(['python3', 'curl']))
  })

  it('still depends on the Electron runtime libraries it replaced', () => {
    // app-builder-lib getDefaultDepends('deb'); keep in sync on upgrade.
    for (const lib of ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6',
      'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0']) {
      expect(depends(), `dropped ${lib} — the package would install and not start`).toContain(lib)
    }
  })

  it('does not make mitmproxy a hard dependency', () => {
    // Web work only; a hard dependency drags a Python toolchain onto machines
    // that never proxy anything.
    expect(depends()).not.toContain('mitmproxy')
  })
})
