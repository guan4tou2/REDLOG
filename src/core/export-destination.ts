import fs from 'fs'
import path from 'path'

// Where an export is written. The default is the project's own `exports/`
// folder. The operator may pick another folder, but the renderer only ever
// NAMES one: a path is accepted only if the main process itself showed it in a
// folder picker (`approved`), so a compromised renderer cannot make an export
// land somewhere the operator never chose.

export type ExportDestination =
  | { ok: true; dir: string; custom: boolean }
  | { ok: false; error: 'invalid-destination' }

export function defaultExportDir(projectDir: string): string {
  return path.join(projectDir, 'exports')
}

export function resolveExportDestination(
  projectDir: string,
  requested: unknown,
  approved: ReadonlySet<string>
): ExportDestination {
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, dir: defaultExportDir(projectDir), custom: false }
  }
  if (typeof requested !== 'string') return { ok: false, error: 'invalid-destination' }
  const dir = path.resolve(requested)
  if (!approved.has(dir)) return { ok: false, error: 'invalid-destination' }
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'invalid-destination' }
  } catch {
    return { ok: false, error: 'invalid-destination' }
  }
  return { ok: true, dir, custom: true }
}
