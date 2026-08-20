import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'

// §10: an operator token is written to `~/.redlog/tokens/`, never shown as
// text to copy. Two properties hold that up, and both are the kind that decay
// silently — nothing looks different when a token starts appearing on screen
// again, or when the directory quietly moves inside the project.

const ROOT = path.join(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')

/** Just the one IPC handler, not everything after it — slicing to the end of
 *  the file makes any "this handler does not mention X" assertion vacuous. */
function writeTokenHandler(): string {
  const main = read('src/main/index.ts')
  const start = main.indexOf("ipcMain.handle('operators:writeToken'")
  expect(start, 'operators:writeToken handler not found').toBeGreaterThan(-1)
  const end = main.indexOf('\n  })', start)
  return main.slice(start, end)
}

describe('operator tokens', () => {
  it('never renders the token itself', () => {
    // A token on the clipboard is a token in every clipboard manager on the
    // machine; a token pasted into a note is a token in whatever that note
    // syncs to. The path is safe to show. The secret is not.
    const settings = read('src/renderer/src/components/Settings.tsx')
    const tokenBlock = settings.slice(settings.indexOf('pendingToken &&'))
    expect(tokenBlock).not.toMatch(/\{pendingToken\.token\}/)
    expect(tokenBlock).not.toMatch(/writeText\(pendingToken/)
  })

  it('writes outside the project tree', () => {
    // Bundle export, evidence packaging and cloud share all walk the project
    // directory. A credential inside it would be swept into an artifact that
    // gets handed to a client.
    const handler = writeTokenHandler()
    expect(handler).toMatch(/homedir\(\), '\.redlog', 'tokens'/)
    expect(handler).not.toMatch(/activeProject/)
  })

  it('creates the file with owner-only permissions from the start', () => {
    // Writing then chmod-ing leaves a window in which the file is
    // world-readable, and that window is enough.
    const handler = writeTokenHandler()
    expect(handler).toMatch(/mode: 0o600/)
    expect(handler).toMatch(/mkdirSync\([^)]*mode: 0o700/)
  })

  it('will not let an operator id escape the directory', () => {
    const handler = writeTokenHandler()
    expect(handler).toMatch(/replace\(\/\[\^A-Za-z0-9\._-\]\/g/)
    expect(handler).toMatch(/'\.\.'/)
  })

  it('has no leftover copy-token affordance anywhere', () => {
    const offenders = glob.sync('src/renderer/src/**/*.{ts,tsx,json}', { cwd: ROOT })
      .filter((f) => /operatorTokenCopy/.test(read(f)))
    expect(offenders).toEqual([])
  })
})
