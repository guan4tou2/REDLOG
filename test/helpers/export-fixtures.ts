import fs from 'fs'
import path from 'path'
import { getDB } from '../../src/core/db/index'

export function addExportEvent(
  table: 'events' | 'events_logged',
  id: string,
  timestamp: number,
  options: { agentType?: string; subtype?: string; data?: Record<string, unknown>; targetId?: string | null } = {}
): void {
  const agentType = options.agentType ?? 'shell'
  const subtype = options.subtype ?? 'command_end'
  const data = JSON.stringify({ subtype, ...(options.data ?? {}) })
  getDB().prepare(`
    INSERT INTO ${table} (id, timestamp, engagement_id, session_id, operator_id,
      agent_type, subtype, hostname, source_ip, target_id, data, created_at
      ${table === 'events' ? ', hash, prev_hash, signature' : ''})
    VALUES (?, ?, 'eng-1', 's', 'op', ?, ?, '', '', ?, ?, ?
      ${table === 'events' ? ", 'h', 'p', 's'" : ''})
  `).run(id, timestamp, agentType, subtype, options.targetId === undefined ? 'example.test' : options.targetId, data, timestamp)
}

export function addExportAttachment(projectDir: string, relativePath: string, content = 'fixture'): string {
  const filePath = path.join(projectDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}
