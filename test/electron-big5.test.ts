// The body index reads a body declared big5 with the runtime's TextDecoder and
// relies on it to fail on invalid bytes (http-body-index.ts): a body that does
// not decode stays binary and coverage says so. Node 24.12's ICU does not —
// it drops invalid Big5 bytes silently — so this is checked under the runtime
// the app ships, Electron's, run as plain Node (no window opens).
import { expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { requires } from './helpers/requires'

const electron = requires('electron-runtime')

const SCRIPT = `
const out = { encoding: new TextDecoder('big5').encoding }
const decode = (hex, fatal) => { try { return new TextDecoder('big5', { fatal }).decode(Buffer.from(hex, 'hex')) } catch (e) { return 'threw ' + e.constructor.name } }
out.valid = decode('a4a4a4e5b5fc', true)
out.invalid = ['80ff41', 'a4a4ff41', 'a4'].map(hex => decode(hex, true))
out.runtime = process.versions.electron + ' / icu ' + process.versions.icu
process.stdout.write(JSON.stringify(out))
`

electron.it('the shipped runtime decodes Big5 and rejects invalid Big5', () => {
  const bin = createRequire(__filename)('electron') as string
  const run = spawnSync(bin, ['-e', SCRIPT], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  expect(run.status, run.stderr).toBe(0)
  const out = JSON.parse(run.stdout) as { encoding: string; valid: string; invalid: string[]; runtime: string }
  console.log(`[electron-big5] electron ${out.runtime}`)
  expect(out).toEqual({ encoding: 'big5', valid: '中文詞', invalid: ['threw TypeError', 'threw TypeError', 'threw TypeError'], runtime: out.runtime })
})
