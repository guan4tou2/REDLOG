// Spec 027 — RED.
//
// The 🔴 utility-process host ran nothing: its `start` and `stop` were empty
// after mcpTools, its only code contribution, was removed in v0.12. What stayed
// was everything around it — a services object in main (including outbound
// `fetch`), a capability checker only a test called, a child script shipped in
// every packaged build and never forked, and two contribution types,
// `exporters` and `monitors`, that marked a plugin privileged, asked the
// operator to grant it trust, and then executed nothing.
//
// The trust gate itself stays: it guards `tailers`, the one privileged
// contribution with a live path.

import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateManifest, tierOf } from '../src/core/plugins/manifest'

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8')

const base = { id: 'sample-plugin', name: 'Sample', version: '1.0.0', redlogApi: 1 }

describe('retired code contributions are refused, not silently inert', () => {
  for (const retired of ['exporters', 'monitors']) {
    it(`rejects a manifest contributing ${retired}, saying why`, () => {
      const parsed = validateManifest({ ...base, contributes: { [retired]: './index.js' } }, '/tmp/x')
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.error).toMatch(new RegExp(retired))
      expect(parsed.error).toMatch(/not supported/)
    })
  }

  it('rejects a manifest contributing mappers: nothing applies them (POST /api/ingest was never built)', () => {
    const parsed = validateManifest({ ...base, contributes: {
      mappers: [{ id: 'm', version: '1', agentType: 'scanner', fields: { host: '$.h' } }]
    } }, '/tmp/x')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/contributes\.mappers is not supported/)
    expect(parsed.error).toMatch(/api\/events/)
  })

  it('still treats tailers as privileged, so the trust gate keeps guarding it', () => {
    expect(tierOf({ ...base, contributes: { tailers: './tailer.js' } } as Parameters<typeof tierOf>[0])).toBe('privileged')
  })
})

describe('the empty code host and what surrounded it are gone', () => {
  it('has no host module', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/core/plugins/host.ts'))).toBe(false)
  })

  it('does not build a services object for a host in main', () => {
    const main = read('src/main/index.ts')
    expect(main).not.toMatch(/createPluginHost|setPluginHost/)
  })

  it('does not ship a child script nothing forks', () => {
    expect(fs.existsSync(path.join(ROOT, 'resources/plugin-runner.js'))).toBe(false)
    expect(read('electron-builder.yml')).not.toMatch(/plugin-runner/)
  })
})
