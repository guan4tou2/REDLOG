import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { readFuseWires, fuseMismatches, configuredFuses, FUSE_INDEX } from '../scripts/verify-fuses.mjs'

const root = path.resolve(__dirname, '..')
const builderConfig = path.join(root, 'electron-builder.yml')

describe('electronFuses in electron-builder.yml', () => {
  const fuses = configuredFuses(builderConfig) as Record<string, boolean>

  it('turns off ELECTRON_RUN_AS_NODE and NODE_OPTIONS in the packaged binary', () => {
    expect(fuses.runAsNode).toBe(false)
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe(false)
  })

  it('names only options the installed electron-builder accepts', () => {
    const scheme = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/scheme.json'), 'utf8'))
    const known = Object.keys(scheme.definitions.FuseOptionsV1.properties)
    const raw = (yaml.load(fs.readFileSync(builderConfig, 'utf8')) as { electronFuses: Record<string, unknown> }).electronFuses
    for (const key of Object.keys(raw)) expect(known, key).toContain(key)
    for (const key of Object.keys(FUSE_INDEX)) expect(known, key).toContain(key)
  })
})

// RunAsNode off breaks anything that runs the RedLog binary as plain Node. None
// does today; this is where a new one would be caught before it ships broken.
describe('nothing in production runs the app binary as Node', () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx|js|cjs|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : [])
  const sources = [...files(path.join(root, 'src')), ...files(path.join(root, 'cli'))]

  it.each([
    ['ELECTRON_RUN_AS_NODE', /ELECTRON_RUN_AS_NODE/],
    ['child_process.fork', /\bfork\s*\(/],
    ['utilityProcess', /\butilityProcess\b/],
    ['spawning process.execPath', /(spawn|execFile|spawnSync|execFileSync)\s*\(\s*process\.execPath/]
  ])('%s', (_name, pattern) => {
    const hits = sources.filter((f) => pattern.test(fs.readFileSync(f, 'utf8')))
      // A comment naming the API is not a call.
      .filter((f) => fs.readFileSync(f, 'utf8').split('\n').some((l) => pattern.test(l) && !/^\s*(\/\/|\*)/.test(l)))
    expect(hits.map((f) => path.relative(root, f))).toEqual([])
  })
})

describe('reading a fuse wire', () => {
  const sentinel = 'TEST-FUSE-SENTINEL'
  const binary = (states: string) => Buffer.concat([Buffer.from('xx'), Buffer.from(sentinel), Buffer.from([1, states.length]), Buffer.from(states), Buffer.from('yy')])

  it('reads each fuse state in wire order', () => {
    expect(readFuseWires(binary('01r1'), sentinel)).toEqual([{ version: 1, states: ['off', 'on', 'removed', 'on'] }])
  })

  it('reads both wires of a universal binary', () => {
    expect(readFuseWires(Buffer.concat([binary('0'), binary('1')]), sentinel)).toHaveLength(2)
  })

  it('names a configured fuse the binary disagrees with', () => {
    const [wire] = readFuseWires(binary('10100000'), sentinel)
    expect(fuseMismatches(wire, { runAsNode: false, enableNodeOptionsEnvironmentVariable: false })).toEqual([
      'runAsNode: expected off, binary has on',
      'enableNodeOptionsEnvironmentVariable: expected off, binary has on'
    ])
    const [flipped] = readFuseWires(binary('00000000'), sentinel)
    expect(fuseMismatches(flipped, { runAsNode: false, enableNodeOptionsEnvironmentVariable: false })).toEqual([])
  })

  it('reports a fuse the Electron build does not have', () => {
    const [short] = readFuseWires(binary('0'), sentinel)
    expect(fuseMismatches(short, { onlyLoadAppFromAsar: true })).toEqual(["onlyLoadAppFromAsar: not in this Electron's fuse wire"])
  })
})
