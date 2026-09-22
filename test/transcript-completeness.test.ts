import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/TranscriptView.tsx'), 'utf8')

describe('Transcript completeness contract', () => {
  it('uses paged event queries and keeps per-bucket cursors', () => {
    expect(source).toMatch(/events\.queryPage/)
    expect(source).toMatch(/nextCursor/)
    expect(source).toMatch(/hasMore/)
  })

  it('shows recent-subset and page-error states', () => {
    expect(source).toMatch(/transcript-completeness/)
    expect(source).toMatch(/transcript-load-error/)
    expect(source).toMatch(/transcript\.loadOlder/)
  })

  it('marks copied Markdown when loaded evidence is partial', () => {
    expect(source).toMatch(/transcript\.partialMarkdown/)
  })
})
