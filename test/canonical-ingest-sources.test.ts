import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const SOURCES = [
  'src/main/terminal-manager.ts',
  'src/main/services/powershell-transcript.ts',
  'src/main/services/agent-tailer.ts',
  'src/main/services/cdp-connector.ts',
  'src/main/services/screenshot-agent.ts',
  'src/main/services/connection-monitor.ts',
  'src/main/services/process-monitor.ts',
  'src/main/services/file-watcher.ts',
  'src/main/services/tailer-host.ts',
  'src/main/clipboard-monitor.ts'
]

describe('canonical ingest source boundary', () => {
  it.each(SOURCES)('%s has no direct event-store writes', (relative) => {
    const source = fs.readFileSync(path.join(process.cwd(), relative), 'utf8')
    expect(source).not.toMatch(/\binsertEvent\s*\(/)
    expect(source).not.toMatch(/\beventBus\.publish\s*\(/)
  })
})
