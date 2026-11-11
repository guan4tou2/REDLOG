// Reads the Electron fuse wire out of a packaged binary and checks it against
// `electronFuses` in electron-builder.yml. electron-builder flips the fuses
// right before signing; this confirms the flip reached the binary that ships.
//
//   node scripts/verify-fuses.mjs [--smoke] <RedLog.app | Resources dir | executable>
//
// Release is the default; --smoke checks the yml with SMOKE_FUSE_OVERRIDES
// applied (scripts/build-variant.mjs). Called by verify-packaged-resources.mjs.
//
// No `#!` line: test/package-fuses.test.ts imports this module, and a shebang
// broke that import on Windows CRLF checkouts.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { SMOKE_FUSE_OVERRIDES, VARIANTS, VARIANT_FILE, readPackagedVariant } from './build-variant.mjs'

// electron-builder's option names, in fuse-wire order (@electron/fuses
// FuseV1Options). Checked against the installed package when it is present.
export const FUSE_INDEX = {
  runAsNode: 0,
  enableCookieEncryption: 1,
  enableNodeOptionsEnvironmentVariable: 2,
  enableNodeCliInspectArguments: 3,
  enableEmbeddedAsarIntegrityValidation: 4,
  onlyLoadAppFromAsar: 5,
  loadBrowserProcessSpecificV8Snapshot: 6,
  grantFileProtocolExtraPrivileges: 7
}
const STATE = { 0x30: 'off', 0x31: 'on', 0x72: 'removed' }

/** Every fuse wire in `buf` (two in a universal macOS binary). */
export function readFuseWires(buf, sentinel) {
  const marker = Buffer.from(sentinel)
  const wires = []
  for (let at = buf.indexOf(marker); at !== -1; at = buf.indexOf(marker, at + 1)) {
    const start = at + marker.length
    const version = buf[start]
    const length = buf[start + 1]
    const states = []
    for (let i = 0; i < length; i++) states.push(STATE[buf[start + 2 + i]] ?? `0x${buf[start + 2 + i].toString(16)}`)
    wires.push({ version, states })
  }
  return wires
}

/** Lines naming each configured fuse whose state in `wire` differs. */
export function fuseMismatches(wire, expected) {
  const problems = []
  if (wire.version !== 1) problems.push(`unknown fuse wire version ${wire.version}`)
  for (const [name, want] of Object.entries(expected)) {
    const index = FUSE_INDEX[name]
    if (index === undefined) { problems.push(`${name}: not a known fuse`); continue }
    if (typeof want !== 'boolean') continue
    const got = wire.states[index]
    if (got === undefined) problems.push(`${name}: not in this Electron's fuse wire`)
    else if (got !== (want ? 'on' : 'off')) problems.push(`${name}: expected ${want ? 'on' : 'off'}, binary has ${got}`)
  }
  return problems
}

/** The `electronFuses` block of electron-builder.yml (fuse options only). */
export function configuredFuses(configFile) {
  const fuses = yaml.load(fs.readFileSync(configFile, 'utf8'))?.electronFuses ?? {}
  return Object.fromEntries(Object.entries(fuses).filter(([k]) => k !== 'resetAdHocDarwinSignature'))
}

/** The fuses a package of `variant` must carry: the yml's, plus the smoke overrides for a smoke build. */
export function expectedFuses(configFile, variant = 'release') {
  if (!VARIANTS.includes(variant)) throw new Error(`Unknown build variant: ${variant}`)
  const fuses = configuredFuses(configFile)
  return variant === 'smoke' ? { ...fuses, ...SMOKE_FUSE_OVERRIDES } : fuses
}

/** The file that carries the fuse wire, from an .app, a Resources dir or an executable. */
export function fuseBinary(target) {
  const app = target.endsWith('.app') ? target
    : target.endsWith(path.join('Contents', 'Resources')) ? path.dirname(path.dirname(target)) : null
  if (app) return path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
  if (fs.statSync(target).isFile()) return target
  // win-unpacked/resources or linux-unpacked/resources: the executable is beside it.
  const dir = path.basename(target) === 'resources' ? path.dirname(target) : target
  const names = ['RedLog.exe', 'redlog', 'RedLog']
  const found = names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p))
  if (!found) throw new Error(`No RedLog executable in ${dir} (looked for ${names.join(', ')})`)
  return found
}

function electronFusesPackage() {
  const require = createRequire(import.meta.url)
  // A dependency of electron-builder (app-builder-lib), present wherever a package is built.
  const constants = require('@electron/fuses/dist/constants.js')
  const { FuseV1Options } = require('@electron/fuses')
  for (const [name, index] of Object.entries(FUSE_INDEX)) {
    const upper = name[0].toUpperCase() + name.slice(1)
    if (FuseV1Options[upper] !== index) throw new Error(`@electron/fuses disagrees on the index of ${name}`)
  }
  return constants.SENTINEL
}

/** Throws with every mismatch; returns the states it read. */
export function verifyFuses(target, configFile, variant = 'release') {
  const binary = fuseBinary(path.resolve(target))
  const wires = readFuseWires(fs.readFileSync(binary), electronFusesPackage())
  if (!wires.length) throw new Error(`No fuse wire in ${binary}`)
  const expected = expectedFuses(configFile, variant)
  const problems = wires.flatMap((w) => fuseMismatches(w, expected))
  if (problems.length) throw new Error(`Electron fuses in ${binary} (checked as a ${variant} build):\n  ${problems.join('\n  ')}`)
  return wires[0].states
}

/**
 * The package is the variant it is being verified as, by both of the things
 * that make it one: the fuses in the binary and the variant the main bundle was
 * built as. A smoke main bundle in a release-fused binary fails as surely as
 * the reverse. Throws naming each disagreement.
 */
export function verifyPackageVariant(resourcesRoot, configFile, variant = 'release') {
  const problems = []
  try { verifyFuses(resourcesRoot, configFile, variant) } catch (e) { problems.push(e.message) }
  let built = null
  try { built = readPackagedVariant(resourcesRoot) } catch (e) { problems.push(e.message) }
  if (built && built !== variant) {
    problems.push(`main bundle was built as a ${built} build (${VARIANT_FILE}), checked as ${variant}` +
      (built === 'smoke' ? ': this package has test hooks enabled and must not ship' : ''))
  }
  if (problems.length) throw new Error(problems.join('\n'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const variant = args.includes('--smoke') ? 'smoke' : 'release'
  const target = args.find((a) => !a.startsWith('--'))
  if (!target || args.some((a) => a.startsWith('--') && a !== '--smoke')) { console.error('Usage: node scripts/verify-fuses.mjs [--smoke] <RedLog.app | Resources dir | executable>'); process.exit(2) }
  const configFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron-builder.yml')
  try {
    const states = verifyFuses(target, configFile, variant)
    for (const [name, index] of Object.entries(FUSE_INDEX)) console.log(`${name.padEnd(40)} ${states[index] ?? '-'}`)
    console.log(`Electron fuses match electron-builder.yml for a ${variant} build`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
