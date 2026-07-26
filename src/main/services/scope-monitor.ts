import { insertEvent } from '../db/events'
import { eventBus } from './event-bus'

interface ScopeConfig {
  enforcement: 'warn' | 'log'
  targets: string[]
  excludeTargets: string[]
}

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o), 0) >>> 0
}

function matchesCIDR(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr
  const [net, bits] = cidr.split('/')
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0
  return (ipToLong(ip) & mask) === (ipToLong(net) & mask)
}

function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return host === pattern.slice(2) || host.endsWith('.' + pattern.slice(2))
  }
  return host === pattern
}

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export class ScopeMonitor {
  private config: ScopeConfig = { enforcement: 'warn', targets: [], excludeTargets: [] }
  private engagementId = 'default'
  private operatorId = 'operator-1'
  private violations: Array<{ target: string; command: string; timestamp: number }> = []

  configure(opts: {
    enforcement?: string
    targets?: string[]
    excludeTargets?: string[]
    engagementId?: string
    operatorId?: string
  }): void {
    if (opts.enforcement) this.config.enforcement = opts.enforcement as ScopeConfig['enforcement']
    if (opts.targets) this.config.targets = opts.targets
    if (opts.excludeTargets) this.config.excludeTargets = opts.excludeTargets
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
  }

  checkTarget(target: string, command: string): { inScope: boolean; violation: boolean } {
    if (this.config.targets.length === 0) return { inScope: true, violation: false }

    const isExcluded = this.config.excludeTargets.some((ex) =>
      IP_RE.test(target) ? matchesCIDR(target, ex) : matchesDomain(target, ex)
    )
    if (isExcluded) {
      this.recordViolation(target, command, 'excluded_target')
      return { inScope: false, violation: true }
    }

    const isInScope = this.config.targets.some((t) =>
      IP_RE.test(target) ? matchesCIDR(target, t) : matchesDomain(target, t)
    )

    if (!isInScope) {
      this.recordViolation(target, command, 'out_of_scope')
      return { inScope: false, violation: true }
    }

    return { inScope: true, violation: false }
  }

  private recordViolation(target: string, command: string, reason: string): void {
    this.violations.push({ target, command, timestamp: Date.now() })

    try {
      const evt = insertEvent('system', {
        subtype: 'scope_violation',
        target,
        command: command.slice(0, 200),
        reason,
        enforcement: this.config.enforcement
      }, { engagementId: this.engagementId, operatorId: this.operatorId, targetId: target })
      eventBus.publish(evt)
    } catch { /* DB may not be ready */ }
  }

  getViolations(): Array<{ target: string; command: string; timestamp: number }> {
    return [...this.violations]
  }

  getViolationCount(): number {
    return this.violations.length
  }

  isConfigured(): boolean {
    return this.config.targets.length > 0
  }
}
