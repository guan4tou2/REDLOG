import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'
import { buildVariantFromEnv, parseVariantFile, readPackagedVariant, SMOKE_BUILD_ENV, VARIANT_FILE } from '../scripts/build-variant.mjs'
import { expectedFuses, verifyPackageVariant } from '../scripts/verify-fuses.mjs'

const root = path.resolve(__dirname, '..')
const builderConfig = path.join(root, 'electron-builder.yml')
const require = createRequire(import.meta.url)

describe('build variant from the build environment', () => {
  it('is release unless REDLOG_SMOKE_BUILD=1', () => {
    expect(SMOKE_BUILD_ENV).toBe('REDLOG_SMOKE_BUILD')
    expect(buildVariantFromEnv({})).toBe('release')
    for (const v of ['0', 'true', 'yes', '', ' 1']) expect(buildVariantFromEnv({ REDLOG_SMOKE_BUILD: v }), v).toBe('release')
    expect(buildVariantFromEnv({ REDLOG_SMOKE_BUILD: '1' })).toBe('smoke')
  })

  it('reads only a known variant back', () => {
    expect(parseVariantFile('{"variant":"release"}\n')).toBe('release')
    expect(parseVariantFile('{"variant":"smoke"}')).toBe('smoke')
    for (const bad of ['', '{}', '{"variant":"debug"}', 'smoke']) expect(() => parseVariantFile(bad), bad).toThrow(/does not name a build variant/)
  })

  it('electron.vite.config.ts feeds the define and the variant file from the same value', () => {
    const src = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')
    expect(src).toMatch(/const buildVariant = buildVariantFromEnv\(process\.env\)/)
    expect(src).toMatch(/__REDLOG_SMOKE_BUILD__: JSON\.stringify\(buildVariant === 'smoke'\)/)
    expect(src).toMatch(/variant: buildVariant/)
  })
})

// ── workflows ────────────────────────────────────────────────────────────────

type Step = { name?: string; run?: string; env?: Record<string, string> }
const steps = (file: string): Step[] => {
  const doc = yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as { jobs: Record<string, { steps?: Step[] }> }
  return Object.values(doc.jobs).flatMap((j) => j.steps ?? [])
}
const builderSteps = (s: Step[]) => s.filter((x) => /\belectron-builder\b/.test(x.run ?? '') && /npx electron-builder/.test(x.run ?? ''))

/** The electron-builder config electron-builder itself resolves for these CLI args. */
async function effectiveFuses(args: string[]): Promise<Record<string, unknown>> {
  const { configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder.js')
  const yargs = require(require.resolve('yargs', { paths: [require.resolve('electron-builder')] }))
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
  const options = normalizeOptions({ ...configureBuildCommand(yargs(args)).parse() })
  const config = await getConfig(root, null, options.config)
  await validateConfiguration(config, { isEnabled: false })
  return config.electronFuses
}
const quotedArgs = (run: string): string[] => [...run.matchAll(/'([^']+)'/g)].map((m) => m[1])

describe('install-smoke workflows build the smoke variant', () => {
  it.each(['linux-install-smoke.yml', 'windows-install-smoke.yml'])('%s', async (file) => {
    const s = steps(file)
    const build = s.filter((x) => x.run?.trim() === 'npm run build')
    expect(build).toHaveLength(1)
    expect(build[0].env?.REDLOG_SMOKE_BUILD).toBe('1')

    const packaging = builderSteps(s)
    expect(packaging).toHaveLength(1)
    const overrides = quotedArgs(packaging[0].run!)
    expect(overrides).toEqual(['--config.electronFuses.enableNodeCliInspectArguments=true'])
    // electron-builder's own parser and merge: the override joins the yml's
    // electronFuses block rather than replacing it.
    expect(await effectiveFuses(['--linux', 'dir', ...overrides])).toEqual(expectedFuses(builderConfig, 'smoke'))

    expect(s.some((x) => x.run?.trim() === 'npm run verify:package-resources:smoke')).toBe(true)
    expect(s.some((x) => x.run?.trim() === 'npm run verify:package-resources')).toBe(false)
  })

  it('without the override electron-builder resolves the release fuses', async () => {
    expect(await effectiveFuses(['--linux', 'dir'])).toEqual(expectedFuses(builderConfig, 'release'))
  })
})

describe('release.yml cannot produce a smoke build', () => {
  const s = steps('release.yml')
  const text = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')

  it('never sets REDLOG_SMOKE_BUILD or overrides electronFuses', () => {
    const doc = yaml.load(text) as { env?: Record<string, string>; jobs: Record<string, { env?: Record<string, string> }> }
    const envs = [doc.env ?? {}, ...Object.values(doc.jobs).map((j) => j.env ?? {}), ...s.map((x) => x.env ?? {})]
    for (const env of envs) expect(Object.keys(env)).not.toContain('REDLOG_SMOKE_BUILD')
    for (const step of s) {
      expect(step.run ?? '', step.name).not.toMatch(/REDLOG_SMOKE_BUILD/)
      expect(step.run ?? '', step.name).not.toMatch(/electronFuses|-c\.|--config/)
    }
    expect(builderSteps(s).length).toBeGreaterThan(0)
  })

  it('verifies the package in release mode', () => {
    expect(s.some((x) => x.run?.trim() === 'npm run verify:package-resources')).toBe(true)
    expect(s.some((x) => /verify:package-resources:smoke|--smoke/.test(x.run ?? ''))).toBe(false)
  })

  it('the release verifier script takes no variant from the environment', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['verify:package-resources']).toBe('node scripts/verify-packaged-resources.mjs')
    expect(fs.readFileSync(path.join(root, 'scripts/verify-packaged-resources.mjs'), 'utf8')).not.toMatch(/process\.env/)
  })
})

// ── the packaged app: fuses and main bundle must both be the variant checked ─

describe('verifyPackageVariant', () => {
  const SENTINEL: string = require('@electron/fuses/dist/constants.js').SENTINEL
  let tmp: string
  const RELEASE_WIRE = '00000000'
  const SMOKE_WIRE = '00010000' // enableNodeCliInspectArguments (index 3) on

  /** A linux-unpacked layout: the executable beside resources/, the main bundle loose or in app.asar. */
  async function pkg(name: string, wire: string, variant: string | null, asar: boolean): Promise<string> {
    const dir = path.join(tmp, name)
    const resources = path.join(dir, 'resources')
    fs.mkdirSync(resources, { recursive: true })
    fs.writeFileSync(path.join(dir, 'redlog'), Buffer.concat([Buffer.from('ELF'), Buffer.from(SENTINEL), Buffer.from([1, wire.length]), Buffer.from(wire), Buffer.from('tail')]))
    const app = path.join(asar ? path.join(tmp, `${name}-src`) : path.join(resources, 'app'))
    fs.mkdirSync(path.join(app, 'out', 'main'), { recursive: true })
    fs.writeFileSync(path.join(app, 'out', 'main', 'index.js'), '// main\n')
    if (variant) fs.writeFileSync(path.join(app, VARIANT_FILE), `${JSON.stringify({ variant })}\n`)
    if (asar) await require('@electron/asar').createPackage(app, path.join(resources, 'app.asar'))
    return resources
  }

  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-variant-')) })
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('passes a release package checked as release, from app.asar and from a loose app/', async () => {
    for (const asar of [true, false]) {
      const r = await pkg(`release-${asar}`, RELEASE_WIRE, 'release', asar)
      expect(readPackagedVariant(r)).toBe('release')
      expect(() => verifyPackageVariant(r, builderConfig)).not.toThrow()
    }
  })

  it('passes a smoke package checked as smoke', async () => {
    const r = await pkg('smoke', SMOKE_WIRE, 'smoke', true)
    expect(() => verifyPackageVariant(r, builderConfig, 'smoke')).not.toThrow()
  })

  it('fails a smoke package checked as release, naming both the fuse and the bundle', async () => {
    const r = await pkg('smoke-as-release', SMOKE_WIRE, 'smoke', true)
    expect(() => verifyPackageVariant(r, builderConfig, 'release')).toThrow(/enableNodeCliInspectArguments: expected off, binary has on[\s\S]*built as a smoke build[\s\S]*must not ship/)
  })

  it('fails when the fuse and the main bundle disagree, either way round', async () => {
    const smokeBundle = await pkg('smoke-bundle', RELEASE_WIRE, 'smoke', true)
    expect(() => verifyPackageVariant(smokeBundle, builderConfig, 'release')).toThrow(/built as a smoke build/)
    expect(() => verifyPackageVariant(smokeBundle, builderConfig, 'smoke')).toThrow(/enableNodeCliInspectArguments: expected on, binary has off/)
    const inspectOn = await pkg('inspect-on', SMOKE_WIRE, 'release', true)
    expect(() => verifyPackageVariant(inspectOn, builderConfig, 'release')).toThrow(/enableNodeCliInspectArguments: expected off, binary has on/)
    expect(() => verifyPackageVariant(inspectOn, builderConfig, 'smoke')).toThrow(/built as a release build/)
  })

  it('fails a package whose main bundle carries no variant', async () => {
    const r = await pkg('no-variant', RELEASE_WIRE, null, true)
    expect(() => verifyPackageVariant(r, builderConfig)).toThrow(/build-variant\.json is not in/)
  })
})
