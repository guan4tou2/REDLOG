import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import { getDB, getProjectDir } from './db/index'
import { queryEvents } from './db/events'
import { listQuickMarks } from './db/findings'
import { listAnchors, computeChainHead } from './chain-anchor'
import { listOperators, getPrimaryOperator, getPrimaryOperatorTokenHash } from './db/operators'
import { getSanitizedFields, countSanitizedEvents } from './sanitize'

interface ManifestFile {
  path: string
  bytes: number
  sha256: string
}

export interface EvidenceBundle {
  outDir: string
  manifest: ManifestPayload
}

interface ManifestPayload {
  bundleVersion: number
  createdAt: string
  hostname: string
  engagementId: string
  signedBy: { operatorId: string; operatorName: string; tokenHashPrefix: string } | null
  chainHead: { hash: string; eventCount: number } | null
  lastAnchor: { id: string; headHash: string; eventCount: number; status: string; createdAt: number } | null
  /** How many events in this bundle carry sanitized bytes instead of raw
   *  captured bytes (four-layer redaction, layer 4). Every one has a paired
   *  system.sanitized event in events.jsonl proving the swap was audited. */
  sanitized: { events: number; totalInDb: number }
  files: ManifestFile[]
}

function sha256File(p: string): { bytes: number; sha256: string } {
  const buf = fs.readFileSync(p)
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
}

function writeAndHash(dest: string, contents: string | Buffer): ManifestFile {
  fs.writeFileSync(dest, contents)
  const info = sha256File(dest)
  return { path: path.basename(dest), bytes: info.bytes, sha256: info.sha256 }
}

export function exportBundle(engagementId: string, outRoot?: string): EvidenceBundle {
  const projectDir = getProjectDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const bundleDir = path.join(outRoot ?? path.join(projectDir, 'exports'), `bundle-${ts}`)
  fs.mkdirSync(bundleDir, { recursive: true })

  const files: ManifestFile[] = []

  // 1. events.jsonl (in insertion order)
  const db = getDB()
  const eventsPath = path.join(bundleDir, 'events.jsonl')
  const fd = fs.openSync(eventsPath, 'w')
  const rowIter = db.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, hash, prev_hash, created_at,
            monotonic_ns, ntp_offset_ms
     FROM events ORDER BY created_at ASC, rowid ASC`
  ).iterate() as IterableIterator<Record<string, unknown>>
  // Four-layer redaction, layer 4: when an event has a sanitized replacement
  // in the sanitized_events table, swap the raw field bytes for the sanitized
  // copy AS WRITTEN TO THE BUNDLE. The source DB row is untouched — the swap
  // only affects the exported file. The row's `hash` field still refers to
  // the original bytes; auditors verifying the chain need the source DB or
  // the paired system.sanitized event to reconcile.
  let sanitizedRowsWritten = 0
  for (const row of rowIter) {
    const eventId = row.id as string
    const replacements = getSanitizedFields(eventId)
    if (Object.keys(replacements).length > 0) {
      try {
        const data = JSON.parse(row.data as string) as Record<string, unknown>
        for (const [field, value] of Object.entries(replacements)) data[field] = value
        row.data = JSON.stringify(data)
        sanitizedRowsWritten++
      } catch { /* leave row as-is if data isn't parseable */ }
    }
    fs.writeSync(fd, JSON.stringify(row) + '\n')
  }
  fs.closeSync(fd)
  files.push({ path: 'events.jsonl', ...sha256File(eventsPath) })

  // 2. quickmarks.json
  files.push(writeAndHash(
    path.join(bundleDir, 'quickmarks.json'),
    JSON.stringify(listQuickMarks(), null, 2)
  ))

  // 3. chain_anchors.json — includes calendar receipts (verifiable off-machine)
  files.push(writeAndHash(
    path.join(bundleDir, 'chain_anchors.json'),
    JSON.stringify(listAnchors(10000), null, 2)
  ))

  // 4. operators.json — public fields only (no token hashes)
  files.push(writeAndHash(
    path.join(bundleDir, 'operators.json'),
    JSON.stringify(listOperators().map((op) => ({
      id: op.id, name: op.name, isPrimary: op.isPrimary,
      createdAt: op.createdAt, revokedAt: op.revokedAt
    })), null, 2)
  ))

  // 5. screenshots/  — copy every jpeg, hash each
  const srcShots = path.join(projectDir, 'screenshots')
  const dstShots = path.join(bundleDir, 'screenshots')
  if (fs.existsSync(srcShots)) {
    fs.mkdirSync(dstShots, { recursive: true })
    for (const name of fs.readdirSync(srcShots)) {
      const s = path.join(srcShots, name)
      const d = path.join(dstShots, name)
      if (fs.statSync(s).isFile()) {
        fs.copyFileSync(s, d)
        const info = sha256File(d)
        files.push({ path: `screenshots/${name}`, ...info })
      }
    }
  }

  // 6. casts/ — copy every asciinema cast if present
  const srcCasts = path.join(projectDir, 'casts')
  const dstCasts = path.join(bundleDir, 'casts')
  if (fs.existsSync(srcCasts)) {
    fs.mkdirSync(dstCasts, { recursive: true })
    for (const name of fs.readdirSync(srcCasts)) {
      const s = path.join(srcCasts, name)
      const d = path.join(dstCasts, name)
      if (fs.statSync(s).isFile()) {
        fs.copyFileSync(s, d)
        const info = sha256File(d)
        files.push({ path: `casts/${name}`, ...info })
      }
    }
  }

  const head = computeChainHead()
  const lastAnchor = listAnchors(1)[0] ?? null
  const primary = getPrimaryOperator()
  const primaryTokenHash = getPrimaryOperatorTokenHash()

  const manifest: ManifestPayload = {
    bundleVersion: 1,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    engagementId,
    signedBy: primary && primaryTokenHash ? {
      operatorId: primary.id,
      operatorName: primary.name,
      tokenHashPrefix: primaryTokenHash.slice(0, 16)
    } : null,
    chainHead: head ? { hash: head.hash, eventCount: head.eventCount } : null,
    lastAnchor: lastAnchor ? {
      id: lastAnchor.id,
      headHash: lastAnchor.headHash,
      eventCount: lastAnchor.eventCount,
      status: lastAnchor.status,
      createdAt: lastAnchor.createdAt
    } : null,
    sanitized: { events: sanitizedRowsWritten, totalInDb: countSanitizedEvents() },
    files
  }

  const manifestPath = path.join(bundleDir, 'manifest.json')
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2))
  fs.writeFileSync(manifestPath, manifestBytes)

  const manifestSha = crypto.createHash('sha256').update(manifestBytes).digest('hex')
  fs.writeFileSync(path.join(bundleDir, 'manifest.sha256'), manifestSha + '\n')

  if (primaryTokenHash) {
    const hmac = crypto.createHmac('sha256', primaryTokenHash).update(manifestBytes).digest('hex')
    fs.writeFileSync(
      path.join(bundleDir, 'manifest.hmac'),
      `hmac_sha256=${hmac}\ntoken_hash_prefix=${primaryTokenHash.slice(0, 16)}\nalgo=HMAC-SHA256(token_hash, manifest.json)\n`
    )
  }

  return { outDir: bundleDir, manifest }
}
