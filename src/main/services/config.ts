import fs from 'fs'
import path from 'path'
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
    expectedCountry: string | null
  }
  scope: {
    enforcement: string
    targets: string[]
    excludeTargets: string[]
    scopeFile: string | null
  }
  encryption: {
    enabled: boolean
    passphrase: string | null
  }
  screenshot: {
    excludeWindows: string[]
    quality: number
    idleDelay: number
    minInterval: number
  }
  clipboard: {
    excludeWindows: string[]
  }
  shipper: {
    enabled: boolean
    backend: string
    elasticsearch: {
      url: string
      index: string
      apiKey: string
    } | null
  }
  sessionHealth: {
    enabled: boolean
    breakReminderMinutes: number
    fatigueYellowMinutes: number
    fatigueRedMinutes: number
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
    emergencyPause: false,
    expectedCountry: null
  },
  scope: {
    enforcement: 'warn',
    targets: [],
    excludeTargets: [],
    scopeFile: null
  },
  encryption: {
    enabled: false,
    passphrase: null
  },
  screenshot: {
    excludeWindows: [],
    quality: 85,
    idleDelay: 3,
    minInterval: 1
  },
  clipboard: {
    excludeWindows: []
  },
  shipper: {
    enabled: false,
    backend: 'elasticsearch',
    elasticsearch: null
  },
  sessionHealth: {
    enabled: false,
    breakReminderMinutes: 240,
    fatigueYellowMinutes: 180,
    fatigueRedMinutes: 360
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
    } else if (source[key] !== undefined) {
      result[key] = source[key]
    }
  }
  return result
}

export function loadConfig(projectDir: string): RedLogConfig {
  const configPath = path.join(projectDir, 'config.yaml')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = yaml.load(raw) as Record<string, unknown>
    return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as unknown as RedLogConfig
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(projectDir: string, config: RedLogConfig): void {
  fs.mkdirSync(projectDir, { recursive: true })
  const configPath = path.join(projectDir, 'config.yaml')
  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }), 'utf-8')
}

export function loadScopeFile(scopeFilePath: string): string[] {
  try {
    const raw = fs.readFileSync(scopeFilePath, 'utf-8')
    const ext = path.extname(scopeFilePath).toLowerCase()

    if (ext === '.json') {
      const data = JSON.parse(raw)
      if (data.target?.scope) {
        return data.target.scope.flatMap((s: { host?: string; protocol?: string }) => {
          if (s.host) return [s.host.replace(/^\\Q|\\E$/g, '').replace(/^\.\*/g, '*')]
          return []
        })
      }
      if (Array.isArray(data)) return data.filter((x: unknown) => typeof x === 'string')
      return []
    }

    return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  } catch {
    return []
  }
}
