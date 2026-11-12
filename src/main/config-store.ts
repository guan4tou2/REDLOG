// The writer of an open project's config.yaml.
//
// Every save — Settings and the capture card (patches), Targets ▸ add to scope,
// the current-target switch, the whole-object `config:save` kept for test
// fixtures, and a new project's seed — goes through here: read the file as it
// is now, change only what the caller changed, validate, write, then apply
// through main/config-apply.ts. The file is the baseline, never the caller's
// copy of it (src/core/config-patch.ts says why). A file that is there but
// cannot be read is no baseline: `loadConfig` throws, and nothing is written
// over it (Settings reports the save as failed and keeps the draft).

import { loadConfig, readConfigRevision, saveConfig, type RedLogConfig } from '../core/config'
import { applyConfigPatch, diffConfig, sameConfigValue, validateConfigPatch, type ConfigSaveResult } from '../core/config-patch'
import type { ProjectContext } from '../core/project-runtime'
import type { ConfigApplyRequest } from './config-apply'

export interface ConfigStoreDeps {
  /** The open project's directory, or null when none is open. */
  projectDir(): string | null
  /** The open project's context, or null. */
  identity(): ProjectContext | null
  /** The operator actually in effect after this save (a blank or refused id
   *  keeps the old one) — applyOperatorChange, which also moves the sources'
   *  identity before anything is written. */
  resolveOperator(prev: RedLogConfig['operator'], next: RedLogConfig['operator'], identity: ProjectContext): RedLogConfig['operator']
  apply(request: ConfigApplyRequest): unknown
}

export interface ConfigStore {
  /** Settings and the capture card: only the fields the page changed. */
  patch(raw: unknown): ConfigSaveResult
  /** The whole-object `config:save`. No production caller is left; the e2e
   *  suite sets its fixtures through it. Last writer wins for the fields it
   *  changes (no base), and it goes through the same validation and apply. */
  saveWhole(raw: unknown, opts?: { expectProjectId?: string }): boolean
  /** Main's own writes. `create` seeds a project that is not the open one. */
  commit(projectDir: string, next: RedLogConfig,
    how: { reason: 'create' } | { reason: 'target-context'; identity: ProjectContext; diskPrev: RedLogConfig }): string
}

export function createConfigStore(deps: ConfigStoreDeps): ConfigStore {
  function patch(raw: unknown): ConfigSaveResult {
    const valid = validateConfigPatch(raw)
    if (!valid.ok) return { ok: false, reason: 'invalid', error: valid.error }
    const projectDir = deps.projectDir()
    const identity = deps.identity()
    if (!projectDir || !identity) return { ok: false, reason: 'no-project' }
    const disk = loadConfig(projectDir)
    // A page is bound to the project it was loaded from. Settings flushes a
    // pending write when it unmounts, and the operator may have switched
    // project by the time it lands; applying one engagement's settings to
    // another is worse than losing the edit.
    if (valid.patch.expectProjectId && valid.patch.expectProjectId !== disk.engagement.id) return { ok: false, reason: 'wrong-project' }
    const { config: patched, conflicts } = applyConfigPatch(disk, valid.patch.ops)
    if (conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts, config: disk, revision: readConfigRevision(projectDir) }
    const next = patched
    // The schema refuses both, but the file's own values are the rule: the
    // project id is the attribution boundary of every row, and the current
    // target has its own audited switch.
    next.engagement.id = disk.engagement.id
    next.engagement.activeTarget = disk.engagement.activeTarget ?? null
    next.operator = { ...next.operator, ...deps.resolveOperator(disk.operator, next.operator, identity) }
    // Nothing changed: no write, and the revision stays where it is.
    const revision = sameConfigValue(next, disk) ? readConfigRevision(projectDir) : saveConfig(projectDir, next)
    deps.apply({ reason: 'save', identity, next, diskPrev: disk })
    return { ok: true, config: next, revision }
  }

  return {
    patch,
    saveWhole(raw, opts) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
      const projectDir = deps.projectDir()
      if (!projectDir) return false
      const disk = loadConfig(projectDir)
      // Whatever the object says about the engagement is ignored, as it always
      // was: the id and the current target are not this call's to write.
      const ops = diffConfig(disk, raw)
        .filter((op) => op.path[0] !== 'engagement')
        .map(({ base: _base, baseAbsent: _absent, ...op }) => op)
      const result = patch({ ops, ...(opts?.expectProjectId ? { expectProjectId: opts.expectProjectId } : {}) })
      if (!result.ok && result.reason === 'invalid') console.warn('[config] whole-object save refused:', result.error)
      return result.ok
    },
    commit(projectDir, next, how) {
      const revision = saveConfig(projectDir, next)
      if (how.reason !== 'create') deps.apply({ reason: how.reason, identity: how.identity, next, diskPrev: how.diskPrev })
      return revision
    }
  }
}
