// Pure audit helpers pulled out of main/index.ts (decomposition): the diff of
// security-relevant config fields written on config:save, and the human summary
// of an OPSEC-state change. Both are pure — no Electron, no module globals — so
// they are unit-testable, which main/index.ts (which imports electron) is not.
// Behaviour is identical to the previous inline versions.

import type { RedLogConfig } from '../core/config'
import type { OpsecStateDelta } from './services/opsec-state'

export type ConfigFieldChange = { from: unknown; to: unknown }

/** The security-relevant fields whose change is worth an audit row on
 *  config:save. Cosmetic settings (Dock icon, HUD flash) are deliberately
 *  excluded — only settings that would affect enforcement or attribution if
 *  silently loosened. Returns a path→{from,to} map of what actually changed
 *  (empty when nothing security-relevant moved). */
export function diffSecurityConfig(
  oldCfg: RedLogConfig,
  newCfg: RedLogConfig
): Record<string, ConfigFieldChange> {
  const changed: Record<string, ConfigFieldChange> = {}
  const check = (path: string, from: unknown, to: unknown): void => {
    // JSON compare so arrays/objects (scope target lists) diff by value.
    if (JSON.stringify(from) !== JSON.stringify(to)) changed[path] = { from, to }
  }
  check('scope.warnOnViolation', oldCfg.scope?.warnOnViolation, newCfg.scope?.warnOnViolation)
  check('scope.targets', oldCfg.scope?.targets, newCfg.scope?.targets)
  check('scope.excludeTargets', oldCfg.scope?.excludeTargets, newCfg.scope?.excludeTargets)
  check('scope.scopeFile', oldCfg.scope?.scopeFile, newCfg.scope?.scopeFile)
  check('network.blacklist', oldCfg.network?.blacklist, newCfg.network?.blacklist)
  check('network.whitelist', oldCfg.network?.whitelist, newCfg.network?.whitelist)
  check('engagement.id', oldCfg.engagement?.id, newCfg.engagement?.id)
  check('operator.id', oldCfg.operator?.id, newCfg.operator?.id)
  check('operator.name', oldCfg.operator?.name, newCfg.operator?.name)
  check('clipboard.enabled', oldCfg.clipboard?.enabled, newCfg.clipboard?.enabled)
  check('network.checkInterval', oldCfg.network?.checkInterval, newCfg.network?.checkInterval)
  check('network.ipMode', oldCfg.network?.ipMode, newCfg.network?.ipMode)
  return changed
}

/** Human one-line summary of an OPSEC-state change for its audit event. */
export function describeOpsecDelta(d: OpsecStateDelta): string {
  const parts: string[] = []
  if (d.vpn) {
    const added = d.vpn.to.filter((x) => !d.vpn!.from.includes(x))
    const removed = d.vpn.from.filter((x) => !d.vpn!.to.includes(x))
    if (added.length) parts.push(`VPN up: ${added.join(', ')}`)
    if (removed.length) parts.push(`VPN down: ${removed.join(', ')}`)
  }
  if (d.primaryMac) parts.push(`MAC ${d.primaryMac.from ?? '?'} → ${d.primaryMac.to ?? '?'}`)
  if (d.dns) {
    const added = d.dns.to.filter((x) => !d.dns!.from.includes(x))
    const removed = d.dns.from.filter((x) => !d.dns!.to.includes(x))
    if (added.length || removed.length) parts.push(`DNS ${d.dns.from.join(',') || '∅'} → ${d.dns.to.join(',') || '∅'}`)
  }
  if (d.hostname) parts.push(`hostname ${d.hostname.from} → ${d.hostname.to}`)
  return parts.join('; ') || 'OPSEC state changed'
}
