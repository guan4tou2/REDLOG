import crypto from 'crypto'
import { getDB } from './index'

export interface Finding {
  id: string
  title: string
  severity: string
  cvssVector: string | null
  cvssScore: number | null
  description: string
  remediation: string
  status: string
  affectedHosts: string[]
  createdAt: number
  updatedAt: number
}

export interface EvidenceLink {
  id: string
  findingId: string
  eventId: string
  note: string
  createdAt: number
}

export interface EventAnnotation {
  id: string
  eventId: string
  note: string
  createdAt: number
}

export function createFinding(data: {
  title: string
  severity?: string
  cvssVector?: string
  cvssScore?: number
  description?: string
  remediation?: string
  affectedHosts?: string[]
}): Finding {
  const db = getDB()
  const now = Date.now()
  const finding: Finding = {
    id: crypto.randomUUID(),
    title: data.title,
    severity: data.severity ?? 'info',
    cvssVector: data.cvssVector ?? null,
    cvssScore: data.cvssScore ?? null,
    description: data.description ?? '',
    remediation: data.remediation ?? '',
    status: 'draft',
    affectedHosts: data.affectedHosts ?? [],
    createdAt: now,
    updatedAt: now
  }

  db.prepare(`
    INSERT INTO findings (id, title, severity, cvss_vector, cvss_score, description, remediation, status, affected_hosts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    finding.id, finding.title, finding.severity, finding.cvssVector, finding.cvssScore,
    finding.description, finding.remediation, finding.status,
    JSON.stringify(finding.affectedHosts), finding.createdAt, finding.updatedAt
  )

  return finding
}

export function updateFinding(id: string, data: Partial<Omit<Finding, 'id' | 'createdAt'>>): Finding | null {
  const db = getDB()
  const existing = getFinding(id)
  if (!existing) return null

  const updated = { ...existing, ...data, updatedAt: Date.now() }

  db.prepare(`
    UPDATE findings SET title=?, severity=?, cvss_vector=?, cvss_score=?, description=?, remediation=?, status=?, affected_hosts=?, updated_at=?
    WHERE id=?
  `).run(
    updated.title, updated.severity, updated.cvssVector, updated.cvssScore,
    updated.description, updated.remediation, updated.status,
    JSON.stringify(updated.affectedHosts), updated.updatedAt, id
  )

  return updated
}

export function getFinding(id: string): Finding | null {
  const db = getDB()
  const row = db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToFinding(row) : null
}

export function listFindings(): Finding[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM findings ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>
  return rows.map(rowToFinding)
}

export function deleteFinding(id: string): boolean {
  const db = getDB()
  const result = db.prepare('DELETE FROM findings WHERE id = ?').run(id)
  return result.changes > 0
}

function rowToFinding(row: Record<string, unknown>): Finding {
  return {
    id: row.id as string,
    title: row.title as string,
    severity: row.severity as string,
    cvssVector: row.cvss_vector as string | null,
    cvssScore: row.cvss_score as number | null,
    description: row.description as string,
    remediation: row.remediation as string,
    status: row.status as string,
    affectedHosts: JSON.parse(row.affected_hosts as string),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  }
}

// --- Evidence Links ---

export function linkEvidence(findingId: string, eventId: string, note = ''): EvidenceLink {
  const db = getDB()
  const link: EvidenceLink = {
    id: crypto.randomUUID(),
    findingId,
    eventId,
    note,
    createdAt: Date.now()
  }
  db.prepare('INSERT INTO evidence_links (id, finding_id, event_id, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(link.id, link.findingId, link.eventId, link.note, link.createdAt)
  return link
}

export function unlinkEvidence(linkId: string): boolean {
  const db = getDB()
  return db.prepare('DELETE FROM evidence_links WHERE id = ?').run(linkId).changes > 0
}

export function getEvidenceForFinding(findingId: string): EvidenceLink[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM evidence_links WHERE finding_id = ? ORDER BY created_at ASC').all(findingId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as string,
    findingId: r.finding_id as string,
    eventId: r.event_id as string,
    note: r.note as string,
    createdAt: r.created_at as number
  }))
}

export function getFindingsForEvent(eventId: string): string[] {
  const db = getDB()
  const rows = db.prepare('SELECT finding_id FROM evidence_links WHERE event_id = ?').all(eventId) as Array<{ finding_id: string }>
  return rows.map((r) => r.finding_id)
}

// --- Event Annotations ---

export function annotateEvent(eventId: string, note: string): EventAnnotation {
  const db = getDB()
  const annotation: EventAnnotation = {
    id: crypto.randomUUID(),
    eventId,
    note,
    createdAt: Date.now()
  }
  db.prepare('INSERT INTO event_annotations (id, event_id, note, created_at) VALUES (?, ?, ?, ?)')
    .run(annotation.id, annotation.eventId, annotation.note, annotation.createdAt)
  return annotation
}

export function getAnnotations(eventId: string): EventAnnotation[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM event_annotations WHERE event_id = ? ORDER BY created_at ASC').all(eventId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as string,
    eventId: r.event_id as string,
    note: r.note as string,
    createdAt: r.created_at as number
  }))
}

export function deleteAnnotation(annotationId: string): boolean {
  const db = getDB()
  return db.prepare('DELETE FROM event_annotations WHERE id = ?').run(annotationId).changes > 0
}
