// Spec 076 T006 (plan "它取代什麼" #1): how many places in src/ read a plugin's
// manifest file and decide what its fields mean.
//
// Today there are three, and they disagree about what a manifest is:
//   1. src/core/plugins/manifest.ts   `validateManifest`, called by loader.ts
//      for every generic `plugin.json` (kinds producer/mapper/enrichment/exporter/pack);
//   2. src/core/hooks-manager.ts      `loadStarterPack` reads starter-pack's
//      `plugin.json` for `builtinProducers`, with an in-code FALLBACK beside it;
//   3. src/core/plugins/official-agents.ts  reads the AI adapters' `plugin.json`
//      for `redlogAgent`.
// Spec 076 Phase 2-3 folds them into one (`core/extensions/manifest.ts`); the
// count may only go down, and only to 1.
//
// What is counted: a parse point is a non-comment line in src/ (renderer
// excluded) that JSON.parses the contents of a manifest file — `plugin.json`
// or `extension.json` — and does not hand the result to `validateManifest`
// within the next six lines (that one is point 1), plus the definition of
// `validateManifest` itself. A file with several such lines counts once: what
// matters is how many readers there are, not how many times each reads.
//
// The list below names them. A new reader fails the test and is printed; a
// reader that is gone is stale and fails too, so the list tracks the count.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from '../helpers/repo-path'

const ROOT = path.join(__dirname, '..', '..')

/** Parse points on origin/main 875092a6, 2026-11-13. Only ever shorter; the floor is 1. */
const PARSE_POINTS = [
  'src/core/hooks-manager.ts',
  'src/core/plugins/manifest.ts',
  'src/core/plugins/official-agents.ts'
]

const MANIFEST_FILE = /['"`](plugin|extension)\.json['"`]/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function parsePoints(): Array<{ file: string; lines: number[] }> {
  const out: Array<{ file: string; lines: number[] }> = []
  for (const abs of glob.sync('src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true, ignore: ['src/renderer/**'] })) {
    const rel = repoRelative(ROOT, abs)
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
    const hits: number[] = []
    lines.forEach((line, i) => {
      if (isComment(line)) return
      if (/\bexport function validateManifest\b/.test(line)) { hits.push(i + 1); return }
      // `JSON.parse(` within three lines of a manifest file name: the reader
      // names the file on the line before, or on the same one.
      if (!/JSON\.parse\(/.test(line)) return
      const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
      if (!MANIFEST_FILE.test(near)) return
      // The generic loader parses and then validates: that is point 1.
      const after = lines.slice(i, i + 7).join('\n')
      if (/\bvalidateManifest\(/.test(after)) return
      hits.push(i + 1)
    })
    if (hits.length) out.push({ file: rel, lines: hits })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

describe('manifest parse points (Spec 076 T006)', () => {
  const found = parsePoints()

  it('the readers are the recorded ones, and the count has not grown', () => {
    const files = found.map((f) => f.file)
    const problems = [
      ...files.filter((f) => !PARSE_POINTS.includes(f)).map((f) => `NEW parse point: ${f}:${found.find((x) => x.file === f)!.lines.join(',')}  (one more reader of a manifest file: fold it into the existing ones)`),
      ...PARSE_POINTS.filter((f) => !files.includes(f)).map((f) => `STALE: ${f} no longer parses a manifest: delete it from PARSE_POINTS`)
    ]
    expect(problems, problems.join('\n')).toEqual([])
    expect(files.length).toBe(PARSE_POINTS.length)
  })

  it('there are three today, and Spec 076 can take that to one but not to none', () => {
    expect(PARSE_POINTS).toHaveLength(3)
    expect(found.length).toBeGreaterThanOrEqual(1)
  })

  it('loader.ts reads the file but does not interpret it: it hands the result to validateManifest', () => {
    const loader = fs.readFileSync(path.join(ROOT, 'src/core/plugins/loader.ts'), 'utf8')
    expect(loader).toMatch(/JSON\.parse\(readFileSync\(join\(dir, 'plugin\.json'\)[\s\S]{0,400}validateManifest\(raw, dir\)/)
    expect(found.map((f) => f.file)).not.toContain('src/core/plugins/loader.ts')
  })
})
