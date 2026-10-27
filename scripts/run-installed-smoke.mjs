#!/usr/bin/env node
// The local default is one recording/delivery journey, with one deliberate
// restart for persistence. Additional suites are selected explicitly by owners.
import { existsSync, statSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const fail = message => { console.error(message); process.exit(1) }
const args = process.argv.slice(2)
if (args.some(arg => arg !== '--list') || args.length > 1) fail('Usage: npm run e2e:smoke -- [--list]')
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
const selected = [cli,'test','e2e/packaged-smoke.spec.ts','--workers=1','--retries=0']
if (args.includes('--list')) {
  console.log('Recording/delivery/restart only; normally two App starts, no automatic reruns.')
  const result = spawnSync(process.execPath,[...selected,'--list','--reporter=list'],{stdio:'inherit'})
  process.exit(result.status ?? 1)
}
const executable = process.env.REDLOG_PACKAGED_APP
if (!executable) fail('Set REDLOG_PACKAGED_APP to the installed executable; no App was started.')
const expected = process.env.REDLOG_EXPECTED_BUILD
if (!expected || !/^[a-f0-9]{8,40}$/.test(expected)) fail('Set REDLOG_EXPECTED_BUILD to the candidate commit; no App was started.')
if (!existsSync(executable) || !statSync(executable).isFile()) fail('REDLOG_PACKAGED_APP is not an installed executable; no App was started.')
if (spawnSync('mitmdump',['--version'],{stdio:'ignore'}).status !== 0) fail('mitmdump is required for this recording/HTTPS smoke; no App was started.')
const report = join(mkdtempSync(join(tmpdir(),'redlog-installed-smoke-')),'report.json')
console.log(`Recording smoke report: ${report}`)
const result = spawnSync(process.execPath,[...selected,'--reporter=line,json'],{
  stdio:'inherit',env:{...process.env,PLAYWRIGHT_JSON_OUTPUT_FILE:report,PLAYWRIGHT_JSON_OUTPUT_NAME:report}
})
if (result.status !== 0) process.exit(result.status ?? 1)
const verified = spawnSync(process.execPath,['scripts/verify-smoke-report.mjs',report],{stdio:'inherit'})
process.exit(verified.status ?? 1)
