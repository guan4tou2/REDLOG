import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// The typecheck is the only guard for a whole class of defect — a name that is
// used but never imported compiles fine under the bundler and throws at
// runtime. One such import went missing in the scope-recompute work and stopped
// capture for three commits; the unit suite never touched that code path.
//
// vitest cannot run tsc for us cheaply, so this asserts the guard is WIRED:
// the script exists, its config covers every source tree, and CI runs it.

const ROOT = path.join(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')

describe('the typecheck guard', () => {
  it('is a script', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.typecheck, 'npm run typecheck is gone').toBeTruthy()
    expect(pkg.scripts.typecheck).toContain('tsconfig.check.json')
  })

  it('covers main, preload, core and the renderer in ONE project', () => {
    // Separate projects per bundle is what let the missing import hide: the
    // preload's config did not list src/core, so the name it referenced simply
    // did not resolve to anything and the error read as noise.
    const cfg = read('tsconfig.check.json')
    expect(cfg).toContain('"src/**/*"')
    expect(cfg).toContain('"noEmit": true')
  })

  it('runs in CI before the tests', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('npm run typecheck')
    expect(ci.indexOf('npm run typecheck'), 'typecheck must run before vitest')
      .toBeLessThan(ci.indexOf('run: npm test'))
  })

  it('leaves the build projects usable too', () => {
    // Both were red on their own — no `target`, so every Map iteration was an
    // error, and node did not list src/core although main imports it. An
    // editor showing hundreds of false errors trains people to ignore all of
    // them, including the true ones.
    for (const f of ['tsconfig.node.json', 'tsconfig.web.json']) {
      expect(read(f), `${f} has no target`).toContain('"target"')
    }
    expect(read('tsconfig.node.json')).toContain('src/core/**/*')
    expect(read('tsconfig.web.json')).toContain('src/core/**/*')
  })
})
