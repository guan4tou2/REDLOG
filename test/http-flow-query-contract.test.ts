import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/HttpHistoryPanel.tsx'), 'utf8')

describe('HTTP flow query contract', () => {
  it('loads complete flow pages instead of a capped event array', () => {
    expect(source).toMatch(/queryHttpFlowPage/)
    expect(source).not.toMatch(/limit:\s*5000/)
  })

  it('exposes completeness, load-more and failure states', () => {
    expect(source).toMatch(/http-completeness/)
    expect(source).toMatch(/http-load-error/)
    expect(source).toMatch(/httpHistory\.loadMore/)
  })
})
