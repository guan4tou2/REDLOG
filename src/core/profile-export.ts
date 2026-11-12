import fs from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'
import type { RedLogConfig } from './config'
import type { ImportedProfile } from './profile-import'

// What "export profile" writes: the five settings import applies
// (profile-import.ts) and the format version, nothing else. It used to dump
// the whole project config under a "share with your team" header, which put
// the operator's id and name, their personal domains and local paths in a
// file made to be handed around.

export interface ExportedProfile extends ImportedProfile {
  version: 1
}

export function exportableProfile(config: RedLogConfig): ExportedProfile {
  return {
    version: 1,
    scope: {
      targets: [...(config.scope?.targets ?? [])],
      excludeTargets: [...(config.scope?.excludeTargets ?? [])],
      warnOnViolation: config.scope?.warnOnViolation !== false
    },
    network: {
      whitelist: [...(config.network?.whitelist ?? [])],
      blacklist: [...(config.network?.blacklist ?? [])]
    }
  }
}

/** JSON for a `.json` path, YAML otherwise. Owner-only: the IP lists name
 *  the engagement's infrastructure. `mode` only applies when the file is
 *  created, so an overwritten file is narrowed as well. */
export function writeProfileFile(filePath: string, profile: ExportedProfile): void {
  const body = path.extname(filePath).toLowerCase() === '.json'
    ? JSON.stringify(profile, null, 2)
    : `# REDLOG Profile — share with your team\n${yaml.dump(profile, { lineWidth: 120 })}`
  fs.writeFileSync(filePath, body, { mode: 0o600 })
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600)
}
