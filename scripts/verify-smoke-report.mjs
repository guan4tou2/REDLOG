#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const failures = []
let count = 0
function walk(suite) {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
    count++
    const last = test.results?.at(-1)
    if (test.expectedStatus !== 'passed' || last?.status !== 'passed') failures.push(`${spec.title}: ${last?.status ?? 'not run'}`)
    for (const a of [...(test.annotations ?? []), ...(last?.annotations ?? [])]) {
      if (a.type === 'not-exercised') failures.push(`${spec.title}: ${a.description}`)
    }
  }
  for (const child of suite.suites ?? []) walk(child)
}
for (const suite of report.suites ?? []) walk(suite)
if (!count) failures.push('No smoke tests ran')
if (!report.stats || report.stats.expected !== count || report.stats.skipped !== 0 || report.stats.unexpected !== 0 || report.stats.flaky !== 0) {
  failures.push('Smoke report is incomplete or contains skipped, failed or flaky tests')
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`${count} smoke test(s) passed; no skipped tests or not-exercised steps`)
