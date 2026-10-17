import type { RedLogConfig } from './config'

// What a JSON export says about the project's configuration. The whole config
// used to be embedded, which carried the operator's own fixed IPs
// (network.blacklist), VPN/VPS exits (network.whitelist) and the domains the
// export itself drops as personal (scope.personalDomains), plus local paths and
// start URLs. Those are the operator's, not the engagement's: the export
// excludes events for them and must not ship the list. Nothing reads this
// block back, so it carries only what a reader needs to interpret the events:
// which engagement, and the scope the verdicts were made against.
export interface ExportedConfig {
  engagement: { id: string; activeTarget: string | null }
  scope: { targets: string[]; excludeTargets: string[] }
}

export function exportableConfig(config: RedLogConfig): ExportedConfig {
  return {
    engagement: { id: config.engagement.id, activeTarget: config.engagement.activeTarget ?? null },
    scope: { targets: [...config.scope.targets], excludeTargets: [...config.scope.excludeTargets] }
  }
}
