import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { agentTypeLabel, LANES, LANE_LABEL_KEYS } from '../src/renderer/src/lib/timelineDomain'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

// The filter bar named types by their storage names (`http_navigation`,
// `credential_use`). It now uses the Timeline's lane names, from one table.
const tr = (d: Record<string, string>) => (k: string): string => d[k] ?? k

describe('agentTypeLabel', () => {
  it('names every lane in both languages', () => {
    for (const lane of LANES) {
      expect(en[LANE_LABEL_KEYS[lane] as keyof typeof en], lane).toBeTruthy()
      expect(zh[LANE_LABEL_KEYS[lane] as keyof typeof zh], lane).toBeTruthy()
    }
  })

  it('shows the operator word, and keeps a plugin type it has no word for', () => {
    expect(agentTypeLabel('http_navigation', tr(en))).toBe('HTTP')
    expect(agentTypeLabel('shell', tr(en))).toBe('Shell')
    expect(agentTypeLabel('acme_scanner', tr(en))).toBe('acme_scanner')
  })

  it('is what the filter bar shows for the type chip and options', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/FilterBar.tsx'), 'utf8')
    expect(src).toMatch(/agentTypeLabel\(filter\.agentType, t\)/)
    expect(src).toMatch(/label: agentTypeLabel\(at, t\)/)
    expect(src).not.toMatch(/label: at \}/)
  })
})
