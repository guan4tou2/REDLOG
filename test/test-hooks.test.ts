import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveTestHooks, SMOKE_BUILD } from '../src/main/test-hooks'

const ON = { REDLOG_E2E: '1', REDLOG_E2E_HIDE_HUD: '1' }

describe('resolveTestHooks', () => {
  it('honours REDLOG_E2E in dev and an unpackaged e2e launch, whatever the variant', () => {
    for (const smoke of [false, true]) expect(resolveTestHooks(ON, false, smoke)).toEqual({ e2e: true, hideHud: true })
  })

  it('honours REDLOG_E2E in a packaged smoke build', () => {
    expect(resolveTestHooks(ON, true, true)).toEqual({ e2e: true, hideHud: true })
  })

  it('ignores every REDLOG_E2E switch in a packaged release build', () => {
    expect(resolveTestHooks(ON, true, false)).toEqual({ e2e: false, hideHud: false })
  })

  it('needs REDLOG_E2E=1 itself; the HUD switch alone does nothing', () => {
    expect(resolveTestHooks({}, false, false)).toEqual({ e2e: false, hideHud: false })
    expect(resolveTestHooks({ REDLOG_E2E: 'true' }, false, false).e2e).toBe(false)
    expect(resolveTestHooks({ REDLOG_E2E_HIDE_HUD: '1' }, false, true)).toEqual({ e2e: false, hideHud: false })
    expect(resolveTestHooks({ REDLOG_E2E: '1' }, false, false)).toEqual({ e2e: true, hideHud: false })
  })

  it('is a release build when nothing compiled the smoke define in', () => {
    expect(SMOKE_BUILD).toBe(false)
  })
})

// The decision has to stay in one place: an env read anywhere else would be a
// test hook a release build honours.
describe('REDLOG_E2E is read only by src/main/test-hooks.ts', () => {
  const root = path.resolve(__dirname, '..')
  const files = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : files(path.join(dir, e.name)))
      : /\.(ts|tsx|js|cjs|mjs|sh|zsh|ps1|py)$/.test(e.name) ? [path.join(dir, e.name)] : [])
  const owner = path.join(root, 'src', 'main', 'test-hooks.ts')
  const sources = ['src', 'cli', 'hooks', 'plugins'].flatMap((d) => files(path.join(root, d))).filter((f) => f !== owner)

  it('finds the sources it scans', () => {
    expect(sources.some((f) => f.endsWith(path.join('src', 'main', 'index.ts')))).toBe(true)
    expect(sources.some((f) => f.endsWith(path.join('src', 'core', 'api-server.ts')))).toBe(true)
  })

  it('has no other reader', () => {
    const hits = sources.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')
      .map((line, i) => ({ line, at: `${path.relative(root, f).split(path.sep).join('/')}:${i + 1}` }))
      // A comment naming the switch is not a read.
      .filter(({ line }) => /REDLOG_E2E/.test(line) && !/^\s*(\/\/|\*|\/\*|#)/.test(line))
      .map(({ at }) => at))
    expect(hits).toEqual([])
  })
})
