// Copy that states a fact about the code is checked against that code here.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve(__dirname, '../src/renderer/src/i18n')
const LOCALES = { en: 'en.json', 'zh-TW': 'zh-TW.json' } as const
const dict = (loc: keyof typeof LOCALES): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(dir, LOCALES[loc]), 'utf8'))

describe.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])('copy facts (%s)', (loc) => {
  const d = dict(loc)

  it('process monitor hint does not claim Windows is unsupported (process-monitor.ts runs on win32)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main/services/process-monitor.ts'), 'utf8')
    expect(src).toMatch(/process\.platform === 'win32'/)
    expect(d['settings.processMonitorEnableHint']).toBeUndefined()
  })
})
