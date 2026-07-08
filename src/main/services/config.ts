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
    allowedIPs: string[]
    checkInterval: number
    emergencyPause: boolean
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
    allowedIPs: [],
    checkInterval: 10,
    emergencyPause: false
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
      network: { ...DEFAULT_CONFIG.network, ...parsed?.network }
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
