import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const feature = 'specs/064-recording-first-workspace/'
const file = process.argv[2] ?? path.join(root, feature, 'coverage-manifest.json')
try {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  const contract = fs.readFileSync(path.join(root, feature, 'contract-acceptance.md'), 'utf8')
  const expected = new Map([...contract.matchAll(/^\| (CT-\d+) .*?\|.*?\|.*?\|.*? · (PASS|PARTIAL|NOT RUN)/gm)].map(m => [m[1], m[2]]))
  if (expected.size !== 16 || manifest.version !== 1 || !Array.isArray(manifest.contracts) || manifest.contracts.length !== expected.size) throw new Error('Expected all 16 CT mappings in version 1')
  const seen = new Set()
  const checkFile = (value, test) => {
    if (typeof value !== 'string' || path.isAbsolute(value) || value.split('/').includes('..') || (test && !/^(test|e2e)\/.+\.(test|spec)\.tsx?$/.test(value))) throw new Error(`Invalid mapped path: ${value}`)
    if (!fs.statSync(path.join(root, value)).isFile()) throw new Error(`Not a file: ${value}`)
  }
  for (const row of manifest.contracts) {
    if (seen.has(row.id) || !expected.has(row.id) || expected.get(row.id) !== row.status) throw new Error(`Missing, duplicate or divergent CT state: ${row.id}`)
    seen.add(row.id)
    for (const key of ['platform', 'remaining']) if (typeof row[key] !== 'string' || !row[key].trim()) throw new Error(`Missing ${key}: ${row.id}`)
    for (const key of ['tests', 'evidence']) {
      if (!Array.isArray(row[key]) || !row[key].length) throw new Error(`Missing ${key}: ${row.id}`)
      row[key].forEach(value => checkFile(value, key === 'tests'))
    }
    if (!row.evidence.includes(feature + 'contract-acceptance.md')) throw new Error(`Missing canonical evidence: ${row.id}`)
  }
  console.log('Contract coverage mappings passed: 16 CT IDs, referenced files and canonical states agree; this does not run tests or grant acceptance.')
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
