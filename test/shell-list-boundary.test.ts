// Spec 075 G5 (T007): "which shells can RedLog hook" is answered from nine
// lists today (plan.md 「現況」), each kept in step with the others by hand.
// The descriptor table (T021) becomes the one list and Phase 5 (T056) takes
// every call site to it; until then this ratchet only goes down.
//
// Two counts:
//
//  1. SITES — the nine lists, found by an anchor on the declaration, not a
//     line number. The plan's bullet names ten places; it counts
//     STARTER_PACK_FALLBACK and the starter-pack manifest it must mirror
//     (a parity test already ties them) as ONE list, which gives nine:
//       1 terminalActivation HOST_ADAPTERS      2 runtime-preflight SHELL_HOOKS
//       3 shell-flavour POSIX_SHELLS            4 shell-flavour shellAdapterFilename
//       5 hooks-manager STARTER_PACK_FALLBACK + plugins/starter-pack/plugin.json
//       6 hooks-manager checkAvailable special cases (sync + async)
//       7 shell-catalog POSIX_SHELL_PATHS       8 hookPlatform WINDOWS_ONLY/POSIX_ONLY
//       9 wsl-manager rcFile choice (plan: wsl-manager.ts:288, 09-F3)
//     To fold one: remove it, add its id to FOLDED, lower BASELINE by one.
//
//  2. LITERALS — single-line array / Set literals in src/ holding two or more
//     shell names. Counted per file; a file not in LITERAL_BASELINE has 0, so a
//     tenth list fails at once. Two exist today that the plan's bullet does
//     not name (capture-health.ts SHELL_HOOK_IDS, WslPanel.tsx's
//     `(['bash','zsh'] as const)`); they are recorded here so they get
//     folded with the rest. Types (`'bash' | 'zsh'`) are not lists and are
//     not counted. Text-based, like test/mutation-guard.test.ts.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

interface Site { id: number; files: Array<{ file: string; anchor: RegExp }>; what: string }
const SITES: Site[] = [
  { id: 1, what: 'terminalActivation HOST_ADAPTERS', files: [{ file: 'src/renderer/src/lib/terminalActivation.ts', anchor: /const HOST_ADAPTERS: Record</ }] },
  { id: 2, what: 'runtime-preflight SHELL_HOOKS', files: [{ file: 'src/core/runtime-preflight.ts', anchor: /const SHELL_HOOKS: Record</ }] },
  { id: 3, what: 'shell-flavour POSIX_SHELLS', files: [{ file: 'src/core/shell-flavour.ts', anchor: /const POSIX_SHELLS = \[/ }] },
  { id: 4, what: 'shell-flavour shellAdapterFilename', files: [{ file: 'src/core/shell-flavour.ts', anchor: /base === 'zsh'\) return 'shell-zsh-hook\.zsh'/ }] },
  { id: 5, what: 'STARTER_PACK_FALLBACK + starter-pack manifest', files: [
    { file: 'src/core/hooks-manager.ts', anchor: /export const STARTER_PACK_FALLBACK: PluginManifest\[\]/ },
    { file: 'plugins/starter-pack/plugin.json', anchor: /"builtinProducers"/ }
  ] },
  { id: 6, what: 'hooks-manager checkAvailable special cases', files: [{ file: 'src/core/hooks-manager.ts', anchor: /plugin\.id === 'shell-zsh'\) return/ }] },
  { id: 7, what: 'shell-catalog POSIX_SHELL_PATHS', files: [{ file: 'src/core/shell-catalog.ts', anchor: /const POSIX_SHELL_PATHS = \[/ }] },
  { id: 8, what: 'hookPlatform WINDOWS_ONLY / POSIX_ONLY', files: [{ file: 'src/renderer/src/lib/hookPlatform.ts', anchor: /const POSIX_ONLY = new Set\(/ }] },
  { id: 9, what: 'wsl-manager rcFile choice', files: [{ file: 'src/core/wsl-manager.ts', anchor: /const rcFile = shell === 'bash' \? '\.bashrc' : '\.zshrc'/ }] }
]
const FOLDED = new Set<number>([])
const BASELINE = 9 // counted 2026-11-13 on origin/main 984a73a2: all nine anchors match.

const stillThere = (s: Site): boolean => s.files.every((f) => f.anchor.test(read(f.file)))

describe('G5: shell lists (Spec 075)', () => {
  it('every named list is either still there or recorded as folded', () => {
    const lost = SITES.filter((s) => !stillThere(s) && !FOLDED.has(s.id))
    expect(lost.map((s) => `${s.id} ${s.what}`),
      'an anchor no longer matches: a rename (fix the anchor) or a fold (add the id to FOLDED, lower BASELINE)').toEqual([])
    expect([...FOLDED].filter((id) => stillThere(SITES.find((s) => s.id === id)!)), 'listed as folded but still there').toEqual([])
  })

  it('the number of shell lists only goes down', () => {
    const left = SITES.filter(stillThere)
    expect(left.length, left.map((s) => `${s.id}  ${s.what}`).join('\n')).toBeLessThanOrEqual(BASELINE)
    expect(BASELINE).toBe(9 - FOLDED.size)
  })
})

const SHELL = `['"](?:zsh|bash|sh|ksh|dash|pwsh|powershell|shell-zsh|shell-bash|shell-powershell|shell-wsl)['"]`
const LIST = new RegExp(`(?:\\[|new Set\\(\\[)[^\\]\\n]*${SHELL}[^\\]\\n]*,[^\\]\\n]*${SHELL}[^\\]\\n]*\\]`)

/** Counted 2026-11-13 on origin/main 984a73a2: 10 lines in 7 files. */
const LITERAL_BASELINE: Record<string, number> = {
  'src/core/capture-health.ts': 1,
  'src/core/runtime-preflight.ts': 2,
  'src/core/shell-flavour.ts': 1,
  'src/core/wsl-manager.ts': 1,
  'src/renderer/src/components/WslPanel.tsx': 1,
  'src/renderer/src/lib/hookPlatform.ts': 2,
  'src/renderer/src/lib/terminalActivation.ts': 2
}

function literals(): Record<string, { count: number; lines: string[] }> {
  const out: Record<string, { count: number; lines: string[] }> = {}
  for (const file of glob.sync('src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (LIST.test(line)) {
        const e = (out[rel] ??= { count: 0, lines: [] })
        e.count++; e.lines.push(`${i + 1}: ${t.slice(0, 90)}`)
      }
    })
  }
  return out
}

describe('G5: no new shell-name list literal in src/', () => {
  it('no file holds more shell-name list literals than its baseline', () => {
    const over = Object.entries(literals())
      .filter(([f, e]) => e.count > (LITERAL_BASELINE[f] ?? 0))
      .map(([f, e]) => `${f}: ${e.count} > ${LITERAL_BASELINE[f] ?? 0}\n    ${e.lines.join('\n    ')}`)
    expect(over, over.join('\n')).toEqual([])
  })
})
