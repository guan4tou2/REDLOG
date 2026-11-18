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

  it('rotation hint states the eviction order, the pin rule and when it runs (body-eviction.ts, main/index.ts)', () => {
    const h = d['settings.rotationHint']
    expect(h).not.toMatch(/coldest|最久未使用/)
    expect(h).toMatch(loc === 'en' ? /oldest/ : /最舊/)
    expect(h).toMatch(loc === 'en' ? /opens|opening/ : /開啟專案/)
    expect(h).toMatch(loc === 'en' ? /no scope/ : /未設定範圍/)
    expect(h).toMatch(/SHA-256/)
  })

  it('logged-tier hint says expired rows are deleted (retention.ts deletes from events_logged)', () => {
    expect(d['settings.retentionLoggedTierHint']).toMatch(loc === 'en' ? /deleted/ : /刪除/)
    expect(d['settings.retentionLoggedTierHint']).not.toMatch(/investigative|調查脈絡/)
  })
})
