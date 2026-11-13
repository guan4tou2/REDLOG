// Spec 075 G2 (T006): nothing but the one status function should decide what a
// capture source or the whole capture is doing. Today twenty places decide it
// for themselves (plan.md 「要取代的判斷」: J1-J7 for the whole, S1-S13 for a
// source), each with its own idea of "ready", "failed" and "worse". Phase 2-6
// fold them into `src/core/sources/status.ts` and `lib/sourceStatusView.ts`
// one step at a time; this ratchet may only go down.
//
// Two counts, because the first is the plan's and the second catches the
// twenty-first:
//
//  1. SITES — the twenty named judgements, each found by an anchor (the
//     declaration that IS the judgement), not by a line number: plan line
//     numbers moved the day after they were written. BASELINE is 20 on
//     origin/main 984a73a2 (2026-11-13); every anchor matches there.
//     To fold one: delete the judgement, add its id to FOLDED, lower BASELINE
//     by one. A missing anchor that is not in FOLDED fails — it is either a
//     rename (fix the anchor) or a fold that forgot to say so.
//
//  2. READS — the G2 pattern list over src/renderer: `.facts`, `.verdict`,
//     `state === 'error'|'ready'|'unset'` (and `!==`), `ownShellLastEventAt`,
//     `httpsVerification`, `managedHttpProxy`, `captureFacts(`. Counted per
//     file, comment lines skipped, `lib/sourceStatusView.ts` exempt (it will be
//     the one reader). READ_BASELINE is a per-file map; a file not in it has
//     a baseline of 0, so a NEW reader fails at once. Lowering is by editing
//     the map in the change that removes the read; raising needs a reason in
//     the PR. Heuristic and text-based, like test/mutation-guard.test.ts: an
//     alias or a destructured `{ verdict }` is not seen.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

interface Site { id: string; file: string; anchor: RegExp; what: string }

// Anchors are the declaration of the judgement. Several judgements share a
// file; each id appears once.
const SITES: Site[] = [
  { id: 'J1', file: 'src/core/capture-health.ts', anchor: /let verdict: CaptureHealth\['verdict'\]/, what: 'everFed / anyWired / producerStalled / verdict' },
  { id: 'J5', file: 'src/renderer/src/lib/captureIssue.ts', anchor: /export function captureIssueView\(/, what: 'captureIssueView + sourceTarget' },
  { id: 'J3', file: 'src/renderer/src/components/StatusBar.tsx', anchor: /prevVerdict\.current === 'healthy' && verdict !== 'healthy'/, what: 'status bar issue, toast, dot, label' },
  { id: 'J4', file: 'src/renderer/src/components/RecordingWorkspace.tsx', anchor: /s\.state === 'error' && !s\.informational/, what: 'failing-source set' },
  { id: 'J6', file: 'cli/redlog-cli.js', anchor: /RECORDING NOTHING/, what: 'dark/partial -> words' },
  { id: 'J2', file: 'src/renderer/src/components/CaptureHealth.tsx', anchor: /const dark = unknown === undefined && \(capture\.verdict === 'dark'/, what: 'dark / partial / coreGap / healthyGap' },
  { id: 'J7', file: 'src/renderer/src/lib/coreCapture.ts', anchor: /export function coreCaptureReady\(/, what: 'coreCaptureReady' },
  { id: 'S1', file: 'src/core/capture-health.ts', anchor: /function stateFrom\(/, what: 'stateFrom and its overrides' },
  { id: 'S12', file: 'src/core/capture-contract.ts', anchor: /export function captureFacts\(/, what: 'captureFacts (half-step)' },
  { id: 'S10', file: 'src/renderer/src/components/CaptureHealth.tsx', anchor: /const isRogue = \(s: CaptureSourceInfo\)/, what: 'isRogue / isProblem / isAgentRow' },
  { id: 'S2', file: 'src/renderer/src/components/CaptureHealth.tsx', anchor: /function coreCommandState\(/, what: 'coreCommandState' },
  { id: 'S13', file: 'src/renderer/src/components/CaptureHealth.tsx', anchor: /function ownShellKey\(/, what: 'ownShellKey' },
  { id: 'S3', file: 'src/renderer/src/lib/httpCaptureState.ts', anchor: /export function httpCaptureState\(/, what: 'httpCaptureState (8 states)' },
  { id: 'S11a', file: 'src/renderer/src/components/CaptureHealth.tsx', anchor: /const verified = http === 'ready' && !!verification/, what: 'HTTPS verified, copy 1 of 2' },
  { id: 'S11b', file: 'src/renderer/src/components/HttpCaptureStep.tsx', anchor: /const verified = running && attempt\.https !== null/, what: 'HTTPS verified, copy 2 of 2' },
  { id: 'S8', file: 'src/renderer/src/components/settings/HooksPanel.tsx', anchor: /\{hook\.installed && \(/, what: 'installed / not installed badge' },
  { id: 'S5', file: 'src/renderer/src/lib/pluginViewModel.ts', anchor: /export function officialProjectLevel\(/, what: 'officialProjectLevel + officialHealth' },
  { id: 'S6', file: 'src/renderer/src/components/settings/AgentsPanel.tsx', anchor: /const projectRecording = /, what: 'projectRecording' },
  { id: 'S7', file: 'src/renderer/src/components/settings/ExternalCaptureGroup.tsx', anchor: /const stateLabel = /, what: 'stateLabel chain' },
  { id: 'S9', file: 'src/renderer/src/components/TerminalView.tsx', anchor: /terminal\.meta\.hookOff/, what: 'pane badge hookOn / hookOff' },
  { id: 'S4', file: 'src/renderer/src/lib/captureReadiness.ts', anchor: /export function computeCaptureReadiness\(/, what: 'statusFor / computeCaptureReadiness / primaryCaptureAction' }
]
// The plan counts S11 as ONE judgement ("two copies of 已驗證"). It is two
// anchors here so that folding one copy is visible; they count as one below.
const COUNTED_ONCE = ['S11a', 'S11b']

/** Judgements folded into the status function, by id. Lower BASELINE with it. */
const FOLDED = new Set<string>([])
const BASELINE = 20

function present(): Site[] {
  return SITES.filter((s) => s.anchor.test(fs.readFileSync(path.join(ROOT, s.file), 'utf8')))
}
const distinctCount = (sites: Site[]): number =>
  new Set(sites.map((s) => (COUNTED_ONCE.includes(s.id) ? 'S11' : s.id))).size

describe('G2: who decides capture status (Spec 075)', () => {
  it('every named judgement is either still there or recorded as folded', () => {
    const found = new Set(present().map((s) => s.id))
    const lost = SITES.filter((s) => !found.has(s.id) && !FOLDED.has(s.id))
    expect(lost.map((s) => `${s.id} ${s.file}: ${s.anchor}`),
      'an anchor no longer matches: a rename (fix the anchor) or a fold (add the id to FOLDED, lower BASELINE)').toEqual([])
    const stale = [...FOLDED].filter((id) => found.has(id))
    expect(stale, 'listed as folded but the judgement is still there').toEqual([])
  })

  it('the number of judgements outside the status function only goes down', () => {
    const left = present()
    expect(distinctCount(left), left.map((s) => `${s.id}  ${s.file}  ${s.what}`).join('\n'))
      .toBeLessThanOrEqual(BASELINE)
  })

  it('the baseline is the plan\'s twenty minus what has been folded', () => {
    const folded = new Set([...FOLDED].map((id) => (COUNTED_ONCE.includes(id) ? 'S11' : id)))
    expect(BASELINE).toBe(20 - folded.size)
  })
})

// ---------------------------------------------------------------------------

const PATTERNS: RegExp[] = [
  /\.facts\b/, /\.verdict\b/,
  /state\s*[!=]==?\s*'(?:error|ready|unset)'/,
  /ownShellLastEventAt/, /httpsVerification/, /managedHttpProxy/, /captureFacts\(/
]
const EXEMPT = new Set(['src/renderer/src/lib/sourceStatusView.ts'])

/** Counted 2026-11-13 on origin/main 984a73a2: 49 lines in 13 files. */
const READ_BASELINE: Record<string, number> = {
  'src/renderer/src/env.d.ts': 3,
  'src/renderer/src/components/CaptureHealth.tsx': 23,
  'src/renderer/src/components/ProjectPicker.tsx': 2,
  'src/renderer/src/components/RecordingWorkspace.tsx': 1,
  'src/renderer/src/components/StatusBar.tsx': 2,
  'src/renderer/src/lib/captureIssue.ts': 4,
  'src/renderer/src/lib/captureReadiness.ts': 2,
  'src/renderer/src/lib/captureUnknown.ts': 1,
  'src/renderer/src/lib/httpCaptureState.ts': 2,
  'src/renderer/src/lib/pluginViewModel.ts': 4,
  'src/renderer/src/components/settings/AgentsPanel.tsx': 1,
  'src/renderer/src/components/settings/ExternalCaptureGroup.tsx': 2,
  'src/renderer/src/components/settings/PluginDetailPanel.tsx': 2
}

function reads(): Record<string, { count: number; lines: number[] }> {
  const out: Record<string, { count: number; lines: number[] }> = {}
  for (const file of glob.sync('src/renderer/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    if (EXEMPT.has(rel)) continue
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (PATTERNS.some((p) => p.test(line))) {
        const e = (out[rel] ??= { count: 0, lines: [] })
        e.count++; e.lines.push(i + 1)
      }
    })
  }
  return out
}

describe('G2: the renderer reads capture status in the old terms only as often as it did', () => {
  it('no file reads more than its baseline, and no new file reads at all', () => {
    const now = reads()
    const over = Object.entries(now)
      .filter(([f, e]) => e.count > (READ_BASELINE[f] ?? 0))
      .map(([f, e]) => `${f}: ${e.count} > ${READ_BASELINE[f] ?? 0} (lines ${e.lines.join(',')})`)
    expect(over, over.join('\n')).toEqual([])
  })
})
