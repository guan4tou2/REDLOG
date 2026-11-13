import fs from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'
import type { RedLogConfig } from './config'
import type { ImportedProfile } from './profile-import'

// What "export profile" writes: the engagement's scope, the target list and the
// exclusion list, and the format version. Nothing else. It used to dump the
// whole project config under a "share with your team" header, then the five
// settings import took; both put the operator's own things (id and name,
// personal domains, local paths, their VPS exits and fixed IPs, their warning
// preference) in a file made to be handed around. The event JSON export
// already refuses to ship those IP lists as "the operator's, not the
// engagement's" (export-config.ts); this file follows it.

export interface ExportedProfile extends ImportedProfile {
  version: 1
}

export function exportableProfile(config: RedLogConfig): ExportedProfile {
  return {
    version: 1,
    scope: {
      targets: [...(config.scope?.targets ?? [])],
      excludeTargets: [...(config.scope?.excludeTargets ?? [])]
    }
  }
}

/** JSON for a `.json` path, YAML otherwise. Owner-only: the scope names the
 *  engagement's targets. `mode` only applies when the file is
 *  created, so an overwritten file is narrowed as well. */
export function writeProfileFile(filePath: string, profile: ExportedProfile): void {
  const body = path.extname(filePath).toLowerCase() === '.json'
    ? JSON.stringify(profile, null, 2)
    : `# REDLOG Profile — share with your team\n${yaml.dump(profile, { lineWidth: 120 })}`
  fs.writeFileSync(filePath, body, { mode: 0o600 })
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600)
}
