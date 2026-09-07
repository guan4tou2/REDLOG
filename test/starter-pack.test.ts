import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { detectHooks, STARTER_PACK_FALLBACK } from '../src/core/hooks-manager'
import { loadPlugins } from '../src/core/plugins/loader'

// §8-2: the built-in capture producers are declared in the bundled
// starter-pack manifest, with the in-code STARTER_PACK_FALLBACK as a safety net.
// These guard the two things that must hold: the manifest actually drives the
// registry (bare ids, no namespacing), and it never drifts from the fallback.

const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'plugins', 'starter-pack', 'plugin.json'), 'utf-8')
) as { contributes: object; builtinProducers: Array<{ id: string; agentType: string; installMethod: string }> }

describe('starter-pack (§8-2)', () => {
  it('drives the built-in registry with BARE ids (not namespaced)', () => {
    const ids = detectHooks().map((h) => h.id)
    for (const id of ['shell-zsh', 'shell-bash', 'codex', 'mitmproxy', 'shell-powershell', 'shell-wsl']) {
      expect(ids, `built-in producer ${id} missing from detectHooks`).toContain(id)
    }
    // None of the built-ins are namespaced (`.`) — that dot is the marker
    // capture-health uses to tell a plugin producer from a built-in.
    expect(ids.filter((id) => id.includes('.')).some((id) => id.startsWith('starter-pack'))).toBe(false)
  })

  it('the manifest and the in-code fallback do not drift', () => {
    const packKeyed = manifest.builtinProducers.map((p) => `${p.id}:${p.agentType}:${p.installMethod}`).sort()
    const fbKeyed = STARTER_PACK_FALLBACK.map((p) => `${p.id}:${p.agentType}:${p.installMethod}`).sort()
    expect(packKeyed).toEqual(fbKeyed)
  })

  it('carries no plugin contributions of its own (no double-registration)', () => {
    // The producers live under `builtinProducers`, read only by hooks-manager;
    // `contributes` is empty so the loader never registers them a second time
    // as namespaced captures.
    expect(manifest.contributes).toEqual({})
  })

  it('loads through the real loader as an active, declarative bundled pack', () => {
    const p = loadPlugins().find((x) => x.manifest.id === 'starter-pack')
    expect(p, 'starter-pack not found on disk').toBeTruthy()
    expect(p?.status).toBe('active')
    expect(p?.tier).toBe('declarative')
    expect(p?.source).toBe('bundled')
  })
})
