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
    safeIPs: string[]
    exposedIPs: string[]
    checkInterval: number
  }
  scope: {
    enforcement: string
    targets: string[]
    excludeTargets: string[]
    scopeFile: string | null
  }
  screenshot: {
    quality: number
  }
  terminal: {
    maxCastBytes: number
  }
  redaction: {
    allowlist: string[]
    denylist: string[]
    entropyThreshold: number
    minLength: number
  }
  deconfliction: {
    enabled: boolean
    url: string
    secret: string
    events: string[]
    subtypes: string[]
    includeData: boolean
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
    safeIPs: [],
    exposedIPs: [],
    checkInterval: 10
  },
  scope: {
    enforcement: 'warn',
    targets: [],
    excludeTargets: [],
    scopeFile: null
  },
  screenshot: {
    quality: 85
  },
  terminal: {
    maxCastBytes: 50 * 1024 * 1024
  },
  redaction: {
    allowlist: [],
    denylist: [],
    entropyThreshold: 4.5,
    minLength: 20
  },
  deconfliction: {
    enabled: false,
    url: '',
    secret: '',
    events: ['marker', 'system', 'credential_use', 'c2_checkin'],
    subtypes: ['scope_violation'],
    includeData: false
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

function migrateConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  const network = parsed.network as Record<string, unknown> | undefined
  if (network) {
    if (network.vpnIPs && !network.safeIPs) {
      network.safeIPs = network.vpnIPs
      delete network.vpnIPs
    }
    if (network.dailyIPs && !network.exposedIPs) {
      network.exposedIPs = network.dailyIPs
      delete network.dailyIPs
    }
  }
  return parsed
}

export function loadConfig(projectDir: string): RedLogConfig {
  const configPath = path.join(projectDir, 'config.yaml')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = migrateConfig(yaml.load(raw) as Record<string, unknown>)
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
        return data.target.scope.flatMap((s: { host?: string }) => {
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
