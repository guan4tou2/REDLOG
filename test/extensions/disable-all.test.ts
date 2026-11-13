// Spec 076 T003 (US1, FR-023): with every bundled plugin switched off, the
// basic paths write the same rows and the same exports as with them on.
//
// Today that is true because none of the six bundled plugins is what writes
// these rows: the shell hooks, the AI tailers, the mitmproxy addon, markers,
// screenshots and artifacts are built into main. Spec 076 moves optional
// sources behind the extension host; the day one of these paths starts to
// depend on a plugin being on, this test goes red. The record it compares with
// is the one in basic-paths.golden.json (T002), run with no state file.
//
// The state file is the one the Plugins page writes: ~/.redlog/plugins/state.json.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { requires } from '../helpers/requires'
import { firstDiff, rowDiff, runBasicPaths, type BasicPathsRun } from './basic-paths-fixture'

const GOLDEN = path.join(__dirname, 'basic-paths.golden.json')
const ROOT = path.join(__dirname, '..', '..')
const BUNDLED = ['builtin-tools', 'c2-tailers', 'pack-host-monitors', 'pack-windows-output', 'pcap-capture', 'starter-pack']

const sqlite = requires('better-sqlite3')

describe('the bundled plugins are the six this test switches off', () => {
  it('plugins/ holds exactly them', () => {
    const dirs = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'plugins', d.name, 'plugin.json')))
      .map((d) => d.name).sort()
    expect(dirs).toEqual(BUNDLED)
  })
})

sqlite.describe('with every bundled plugin disabled (Spec 076 T003)', () => {
  it('the loader reports all six as disabled, and the basic paths still write the recorded rows and exports', async () => {
    const statuses: Record<string, string> = {}
    const run: BasicPathsRun = JSON.parse(JSON.stringify(await runBasicPaths({
      beforeSources: async (home) => {
        const dir = path.join(home, '.redlog', 'plugins')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ disabled: BUNDLED }))
        // HOME is the fixture's temp home here; the loader reads it through os.homedir().
        const { loadPlugins } = await import('../../src/core/plugins/loader')
        for (const p of loadPlugins()) if (p.source === 'bundled') statuses[p.manifest.id] = p.status
      }
    })))
    expect(statuses).toEqual(Object.fromEntries(BUNDLED.map((id) => [id, 'disabled'])))
    const golden: BasicPathsRun = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
    expect(run.rowsPerStep).toEqual(golden.rowsPerStep)
    run.rows.forEach((row, i) => expect(row, `row ${i} (${row.step}) first difference at ${rowDiff(run, golden, i)}`).toEqual(golden.rows[i]))
    expect(run.rows).toHaveLength(golden.rows.length)
    expect(run.exports, `exports: first difference at ${firstDiff(run.exports, golden.exports)}`).toEqual(golden.exports)
  })
})
