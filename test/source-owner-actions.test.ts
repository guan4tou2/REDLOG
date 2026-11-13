// Spec 075 G4 (T008): a source's state is changed from ONE place, its owner
// (descriptor `setup.owner`). Today the same switch is reachable from several:
// the Dashboard card installs the shell hook, the first-run flow installs it,
// Settings starts and stops the proxy, a pack group "repairs" a plugin by
// enabling it. Spec 075 T054 deletes the duplicates; this allowlist is the
// set of renderer files that change a source's state TODAY, and it may only
// get shorter.
//
// What counts as changing a source's state (renderer only; main-process IPC
// handlers are the other end of the same calls and are not listed twice):
//   hooks        window.redlog.hooks.install / uninstall
//   http         window.redlog.httpCapture.start / stop
//   plugins      setEnabled / grant / revoke / installOfficialAgent /
//                uninstallOfficialAgent, through `window.redlog.plugins` or the
//                `api` alias PluginsPanel takes of it
//   config       a write of `packs`, `packMembers` or `agentTailer.sources`
//                (an object literal assigned to one of them: `packs: {`,
//                `packMembers: {`, `sources: {`)
// Text-based, like test/mutation-guard.test.ts: a call through another alias
// is not seen. Comment lines are skipped.
//
// To shorten: remove the call from the file and its path from ALLOWED in the
// same change. A path that no longer matches must be removed — a stale entry
// would leave room for the call to return unnoticed. A new file that changes
// a source's state fails; if that is really wanted, it is the owner.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

type Area = 'hooks' | 'http' | 'plugins' | 'config'
const DETECT: Record<Area, RegExp> = {
  hooks: /window\.redlog\??\.hooks\??\.(?:install|uninstall)\(/,
  http: /window\.redlog\??\.httpCapture\??\.(?:start|stop)\(/,
  plugins: /\b(?:window\.redlog\??\.plugins|api)\??\.(?:setEnabled|grant|revoke|installOfficialAgent|uninstallOfficialAgent)\(/,
  config: /\b(?:packs|packMembers|sources)\s*:\s*\{/
}

/** Counted 2026-11-13 on origin/main 984a73a2: 9 (file, area) pairs in 8 files. */
const ALLOWED: Record<Area, string[]> = {
  hooks: [
    'src/renderer/src/components/CaptureHealth.tsx',      // Dashboard card install cta
    'src/renderer/src/components/RecordTerminalFlow.tsx', // first-run install
    'src/renderer/src/lib/hookRemoval.ts'                  // uninstall
  ],
  http: [
    'src/renderer/src/components/HttpCaptureStep.tsx',    // first-run start
    'src/renderer/src/components/settings/BrowserPanel.tsx' // Settings start/stop
  ],
  plugins: [
    'src/renderer/src/components/settings/CapturePackGroup.tsx', // 「修復」: enables the pack's plugin
    'src/renderer/src/components/settings/PluginsPanel.tsx'      // enable, disable, grant, revoke, official install
  ],
  config: [
    'src/renderer/src/components/settings/AgentsPanel.tsx',      // agentTailer.sources
    'src/renderer/src/components/settings/CapturePackGroup.tsx'  // packs, packMembers
  ]
}

function actors(): Record<Area, Record<string, number[]>> {
  const out: Record<Area, Record<string, number[]>> = { hooks: {}, http: {}, plugins: {}, config: {} }
  for (const file of glob.sync('src/renderer/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      for (const area of Object.keys(DETECT) as Area[]) {
        if (DETECT[area].test(line)) (out[area][rel] ??= []).push(i + 1)
      }
    })
  }
  return out
}

describe('G4: who changes a source (Spec 075)', () => {
  const found = actors()
  for (const area of Object.keys(ALLOWED) as Area[]) {
    it(`${area}: only the files allowed today change source state`, () => {
      const extra = Object.keys(found[area]).filter((f) => !ALLOWED[area].includes(f))
        .map((f) => `${f} (lines ${found[area][f].join(',')})`)
      expect(extra, `not on the ${area} allowlist; the owner is the only place that may do this`).toEqual([])
    })
    it(`${area}: the allowlist has no stale entry`, () => {
      const stale = ALLOWED[area].filter((f) => !(f in found[area]))
      expect(stale, 'no longer changes source state: delete it from ALLOWED').toEqual([])
    })
  }
})
