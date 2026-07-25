import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'

export interface RedLogConfig {
  engagement: {
    id: string
    name: string
  }
  operator: {
    id: string
    name: string
  }
  network: {
    vpnIPs: string[]
    dailyIPs: string[]
    checkInterval: number
    emergencyPause: boolean
  }
  scope: {
    enforcement: string
    targets: string[]
    excludeTargets: string[]
  }
}

const DEFAULT_CONFIG: RedLogConfig = {
  engagement: {
    id: 'default',
    name: 'Default Engagement'
  },
  operator: {
    id: 'operator-1',
    name: 'Operator'
  },
  network: {
    vpnIPs: [],
    dailyIPs: [],
    checkInterval: 10,
    emergencyPause: false
  },
  scope: {
    enforcement: 'warn',
    targets: [],
    excludeTargets: []
  }
}

export function loadConfig(): RedLogConfig {
  const configPath = path.join(os.homedir(), '.redlog', 'config.yaml')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = yaml.load(raw) as Partial<RedLogConfig>
    return {
      engagement: { ...DEFAULT_CONFIG.engagement, ...parsed?.engagement },
      operator: { ...DEFAULT_CONFIG.operator, ...parsed?.operator },
      network: { ...DEFAULT_CONFIG.network, ...parsed?.network },
      scope: { ...DEFAULT_CONFIG.scope, ...parsed?.scope }
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
