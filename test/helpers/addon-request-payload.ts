// What hooks/mitmproxy-addon.py sends as `data` for a request, by running the
// addon's own `request` hook under Python (test/fixtures/mitm-request-payload.py).
// Tests that need the producer's real payload shape use this instead of
// writing the shape by hand.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface RequestCase { contentType: string; body: Buffer; url?: string }
export type RequestResult = { data: Record<string, unknown> } | { error: string }

const ROOT = path.resolve(__dirname, '..', '..')

export function runAddonRequests(cases: RequestCase[], opts: { addon?: string; python?: string; env?: Record<string, string> } = {}): { python: string; results: RequestResult[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-addon-home-'))
  try {
    const run = spawnSync(opts.python ?? 'python3', ['-I', path.join(ROOT, 'test', 'fixtures', 'mitm-request-payload.py'), opts.addon ?? path.join(ROOT, 'hooks', 'mitmproxy-addon.py')], {
      input: JSON.stringify(cases.map(c => ({ content_type: c.contentType, body_b64: c.body.toString('base64'), ...(c.url ? { url: c.url } : {}) }))),
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...opts.env, HOME: home, USERPROFILE: home }, maxBuffer: 64 * 1024 * 1024
    })
    if (run.status !== 0) throw new Error(`addon fixture failed (${run.status}): ${run.stderr}`)
    return JSON.parse(run.stdout) as { python: string; results: RequestResult[] }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}
