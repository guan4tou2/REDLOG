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
import { getSanitizedIo, runScopeSanitize } from './scope-sanitize'
import { buildAdherenceReport, summariseAdherence, type ScopeConfigSnapshot } from './scope-adherence'
import { classifyTarget } from './scope-monitor'

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
  /** G-D1: the POSITIVE proof, in the manifest so a reviewer reading only this
   *  file sees the claim. The evidence for it is `scope-adherence.json`, which
   *  is itself in `files` and therefore under the manifest hash + HMAC. Null
   *  when no scope was configured — there is nothing to claim. */
  scopeAdherence: {
    summary: string
    totals: Record<string, number>
    scopeChanges: number
    disagreements: number
    provenance: { path: string; digest: string; entries: number } | null
  } | null
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

export interface ExportBundleOpts {
  outRoot?: string
  /** v0.7.2 F: include the raw Claude Code (and future OpenCode / Codex)
   *  transcripts from `<projectDir>/agent-transcripts/` in the bundle.
   *  DEFAULT FALSE. The sidecar `.jsonl` files are verbatim copies of the
   *  agent's own transcript, which may include operator-pasted secrets
   *  (API keys the operator typed into a Claude Code chat to test auth,
   *  passwords used in an example, etc.). The `agent.transcript_snapshot`
   *  event's sha256 lets an auditor verify the sidecar hasn't been
   *  tampered with WITHOUT them needing the raw file — so redacted export
   *  is the safe default, and this flag is the opt-in for engagements that
   *  legitimately need the pre-redaction content. */
  includeAgentTranscripts?: boolean
  /** Export profile (SPEC-SCOPE-AWARE-LIFECYCLE.md §9 progressive disclosure).
   *  `internal` (default) exports full content. `client-deliverable` runs the
   *  scope planner first — out-of-scope / excluded event bodies AND their io
   *  sidecar bodies are sanitized (the scope_violation + touched host remain),
   *  `unknown` targets are left for operator decision. Requires `scope` +
   *  `operatorId` so the sanitize can attribute + classify. */
  profile?: 'internal' | 'client-deliverable'
  /** Scope config. Required by the `client-deliverable` profile's sanitize
   *  pass; also drives the adherence report (G-D1) in EVERY profile when
   *  present. The extra fields are optional so the sanitize caller is
   *  unaffected — they only sharpen the classification. */
  scope?: ScopeConfigSnapshot
  /** Operator id that owns the sanitize pass (client-deliverable profile). */
  operatorId?: string
  /** Also sanitize `unknown`-target events (operator opt-in, default false). */
  sanitizeUnknown?: boolean
}

export function exportBundle(engagementId: string, outRootOrOpts?: string | ExportBundleOpts): EvidenceBundle {
  const opts: ExportBundleOpts = typeof outRootOrOpts === 'string'
    ? { outRoot: outRootOrOpts }
    : (outRootOrOpts ?? {})
  const outRoot = opts.outRoot
  const projectDir = getProjectDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const bundleDir = path.join(outRoot ?? path.join(projectDir, 'exports'), `bundle-${ts}`)
  fs.mkdirSync(bundleDir, { recursive: true })

  // client-deliverable profile: run the scope sanitize pass BEFORE packaging so
  // the events.jsonl + io swaps below serve redacted out-of-scope content. The
  // pass appends a chained system.sanitized (tamper-evident) and writes to the
  // sanitized_events / sanitized_io side tables the export already reads.
  if (opts.profile === 'client-deliverable' && opts.scope && opts.operatorId) {
    const candidates = queryEvents({ limit: 1_000_000 }).map((e) => ({ id: e.id, targetId: e.targetId, data: e.data }))
    runScopeSanitize({
      events: candidates,
      classify: (t) => classifyTarget(t, opts.scope!),
      operatorId: opts.operatorId,
      engagementId,
      includeUnknown: opts.sanitizeUnknown === true
    })
  }

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
  // G-D1: the adherence report is built from the rows AS WRITTEN TO THE BUNDLE,
  // after the layer-4 swap — never from the raw DB. That is the invariant that
  // keeps a `client-deliverable` bundle honest: the report's command samples
  // can only ever contain what the bundle itself already contains, so it cannot
  // become a side channel around the sanitize gate. Do not move this above the
  // swap. (The scope planner leaves `detectedTarget` in place — the host stays,
  // the exchange is what gets stripped — so the classification still works.)
  const adherenceRows: Array<{
    timestamp: number; agentType: string; targetId?: string | null; data?: Record<string, unknown> | null
  }> = []
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

    // Cheap pre-filter: parsing every row of a 100k-event engagement to find
    // the few that name a target is the wrong trade. A substring test on the
    // raw JSON decides whether the parse is worth it; `target_id` is a column,
    // so rows carrying only that are caught without any parse at all.
    const rawData = String(row.data ?? '')
    const mayMatter = rawData.includes('"detectedTarget"')
      || rawData.includes('"scope_violation"')
      || rawData.includes('"config_changed"')
    if (!mayMatter && !row.target_id) continue
    let parsed: Record<string, unknown> | null = null
    if (mayMatter) { try { parsed = JSON.parse(rawData) } catch { parsed = null } }
    adherenceRows.push({
      timestamp: Number(row.timestamp),
      agentType: String(row.agent_type),
      targetId: (row.target_id as string | null) ?? null,
      data: parsed
    })
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

  // 4. operators.json — public fields only (no token hashes).
  // v0.6.94: include signerPubKey so a standalone verifier (tools/redlog-verify.py)
  // can validate Ed25519 signatures without touching the RedLog DB. The pubkey
  // is not secret — it's the counterpart to the private signing key that stays
  // in ~/.redlog/keys/<operator>.key.
  files.push(writeAndHash(
    path.join(bundleDir, 'operators.json'),
    JSON.stringify(listOperators().map((op) => ({
      id: op.id, name: op.name, isPrimary: op.isPrimary,
      createdAt: op.createdAt, revokedAt: op.revokedAt,
      signerPubKey: op.signerPubKey
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

  // 6a. io/ — copy every sidecar body (io_ref, SPEC-IO-SIDECAR.md). The events
  // carry only the sha256; the full HTTP request/response bodies live here, so
  // a bundle without them would verify but be unreadable. Each file is
  // content-addressed (its name IS its sha256), and hashed into the manifest
  // like casts/screenshots so an auditor can confirm the bytes match the digest
  // the chain attests. A retention-pruned body simply isn't present — the
  // manifest omission is the honest record, same as a pruned cast.
  const srcIo = path.join(projectDir, 'io')
  const dstIo = path.join(bundleDir, 'io')
  if (fs.existsSync(srcIo)) {
    // Layer-4 scope sanitize (SPEC-SCOPE-AWARE-LIFECYCLE.md Part B): a body with
    // a sanitized replacement is served REDACTED under its original digest name;
    // verify reads the system.sanitized io swap and confirms the bytes hash to
    // the replacement digest → sanitized, not tampered. The source store is
    // untouched. One replacement per digest (io bodies are deduped).
    const sanitizedIo = getSanitizedIo()
    const writtenSanitized = new Set<string>()
    fs.mkdirSync(dstIo, { recursive: true })
    for (const name of fs.readdirSync(srcIo)) {
      const s = path.join(srcIo, name)
      if (!(name.endsWith('.bin') || name.endsWith('.bin.gz')) || !fs.statSync(s).isFile()) continue
      const stem = name.replace(/\.bin(\.gz)?$/, '')
      const swap = sanitizedIo.get(stem)
      if (swap) {
        // Write the redacted replacement once, as an uncompressed `.bin`.
        if (writtenSanitized.has(stem)) continue
        writtenSanitized.add(stem)
        const outName = `${stem}.bin`
        const d = path.join(dstIo, outName)
        fs.writeFileSync(d, Buffer.from(swap.value, 'utf8'))
        files.push({ path: `io/${outName}`, ...sha256File(d) })
      } else {
        const d = path.join(dstIo, name)
        fs.copyFileSync(s, d)
        files.push({ path: `io/${name}`, ...sha256File(d) })
      }
    }
  }

  // 6b. agent-transcripts/ — copied ONLY when opts.includeAgentTranscripts.
  // Default-exclude rationale: the raw sidecar `.jsonl` files hold verbatim
  // conversation content (user prompts + assistant responses + tool_use +
  // tool_result), which may include operator-pasted secrets. The DB-side
  // events these transcripts derive are already redacted (v0.7.2 A ports
  // the shell-hook regex into src/core/redaction.ts) and DO ship in
  // events.jsonl. Whole-file sha256 lives in `agent.transcript_snapshot`
  // events, so an auditor can prove tamper-freedom without seeing the
  // raw bytes — they only need the raw file for content review, which is
  // an opt-in choice.
  if (opts.includeAgentTranscripts) {
    const srcAgent = path.join(projectDir, 'agent-transcripts')
    const dstAgent = path.join(bundleDir, 'agent-transcripts')
    if (fs.existsSync(srcAgent)) {
      fs.mkdirSync(dstAgent, { recursive: true })
      for (const name of fs.readdirSync(srcAgent)) {
        const s = path.join(srcAgent, name)
        const d = path.join(dstAgent, name)
        if (fs.statSync(s).isFile()) {
          fs.copyFileSync(s, d)
          const info = sha256File(d)
          files.push({ path: `agent-transcripts/${name}`, ...info })
        }
      }
    }
  }

  // v0.6.94 C: ship a standalone chain verifier inside the bundle so the
  // recipient can prove tamper-freedom without installing Node/Electron/
  // better-sqlite3. Python 3 stdlib is enough for the hash chain; Ed25519
  // signature verification is optional (requires `pip install cryptography`).
  // See tools/redlog-verify.py and docs/CLOUD_SHARE_BUNDLE.md.
  // __dirname resolves differently between dev (src/core/) and packaged
  // builds (out/main/). Try the same two-then-three-parents pattern
  // hooks-manager.ts uses for shipped assets, then fall back to cwd.
  const verifierCandidates = [
    path.join(__dirname, '..', '..', '..', 'tools', 'redlog-verify.py'),
    path.join(__dirname, '..', '..', 'tools', 'redlog-verify.py'),
    path.join(process.cwd(), 'tools', 'redlog-verify.py')
  ]
  const verifierResolved = verifierCandidates.find((p) => fs.existsSync(p)) ?? null
  if (verifierResolved) {
    const verifierBytes = fs.readFileSync(verifierResolved)
    const verifierDest = path.join(bundleDir, 'redlog-verify.py')
    fs.writeFileSync(verifierDest, verifierBytes)
    const info = sha256File(verifierDest)
    files.push({ path: 'redlog-verify.py', ...info })

    const shWrapper = [
      '#!/usr/bin/env bash',
      '# RedLog bundle verifier — thin wrapper around redlog-verify.py.',
      '# Requires: python3 (stdlib only for hash chain; `pip install cryptography`',
      '# to also verify Ed25519 signatures).',
      'set -euo pipefail',
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'exec python3 "$DIR/redlog-verify.py" "$DIR" "$@"',
      ''
    ].join('\n')
    const shDest = path.join(bundleDir, 'verify.sh')
    fs.writeFileSync(shDest, shWrapper, { mode: 0o755 })
    files.push({ path: 'verify.sh', ...sha256File(shDest) })

    // A tiny cmd.exe wrapper so Windows recipients can double-click / run
    // `verify.cmd` — same UX as `bash verify.sh`.
    const cmdWrapper = [
      '@echo off',
      'REM RedLog bundle verifier — thin wrapper around redlog-verify.py.',
      'REM Requires: python3 on PATH.',
      'python "%~dp0redlog-verify.py" "%~dp0." %*',
      ''
    ].join('\r\n')
    const cmdDest = path.join(bundleDir, 'verify.cmd')
    fs.writeFileSync(cmdDest, cmdWrapper)
    files.push({ path: 'verify.cmd', ...sha256File(cmdDest) })

    // Tiny README so the recipient knows what button to press.
    const readme = [
      '# RedLog evidence bundle',
      '',
      'Verify the audit chain is intact before trusting anything in this bundle.',
      '',
      '## Verify (macOS / Linux)',
      '',
      '```',
      'bash verify.sh',
      '```',
      '',
      '## Verify (Windows)',
      '',
      '```',
      'verify.cmd',
      '```',
      '',
      'Both wrappers invoke `python3 redlog-verify.py .` — Python 3.8+ stdlib is',
      'enough to verify the SHA-256 hash chain. To also verify each event\'s',
      'Ed25519 signature, install the optional dependency:',
      '',
      '```',
      'pip install cryptography',
      '```',
      '',
      'The verifier reads `manifest.json`, `events.jsonl`, and `operators.json`',
      'from this directory and prints a summary: events walked, chain intact or',
      'broken at event X, signature verified counts.',
      '',
      '## Scope adherence',
      '',
      '`scope-adherence.json` is the POSITIVE record: every target touched during',
      'this engagement and how each one classifies against the declared scope —',
      'in scope, explicitly excluded, adjacent to something in scope, or off-list.',
      'The violation list alone cannot tell you three near-misses out of 250',
      'targets from three out of five; this file carries the denominator.',
      '',
      'Its `scope.provenance.digest` is the sha256 of the scope FILE the',
      'engagement was judged against. Recompute it against the scope document you',
      'issued to confirm they are the same list:',
      '',
      '```',
      'shasum -a 256 /path/to/the/scope/file/you/issued',
      '```',
      '',
      'Two fields deserve a read even when the counts look clean:',
      '`scopeChanges` lists scope edits made during the engagement (the counts',
      'judge the whole window by the FINAL scope), and `disagreements` lists any',
      'target whose classification today differs from what was recorded at the',
      'time. Both empty is the ordinary case.',
      ''
    ].join('\n')
    const readmeDest = path.join(bundleDir, 'README.md')
    fs.writeFileSync(readmeDest, readme)
    files.push({ path: 'README.md', ...sha256File(readmeDest) })
  }

  const head = computeChainHead()
  const lastAnchor = listAnchors(1)[0] ?? null
  const primary = getPrimaryOperator()
  // G-D1 in the bundle. `data:exportAdherence` produces the same report as a
  // loose file; here it is a hashed entry in `files`, so it inherits the
  // manifest sha256 + HMAC and travels signed with everything else. Without a
  // scope there is nothing to claim, so no file and a null manifest block —
  // an empty report would read as "nothing was out of bounds".
  let adherenceBlock: ManifestPayload['scopeAdherence'] = null
  if (opts.scope && opts.scope.targets.length > 0) {
    const report = buildAdherenceReport(adherenceRows, opts.scope, {
      generatedAt: Date.now(),
      engagementId
    })
    files.push(writeAndHash(
      path.join(bundleDir, 'scope-adherence.json'),
      JSON.stringify(report, null, 2)
    ))
    adherenceBlock = {
      summary: summariseAdherence(report),
      totals: report.totals as unknown as Record<string, number>,
      scopeChanges: report.scopeChanges.length,
      disagreements: report.disagreements.length,
      provenance: report.scope.provenance
        ? {
            path: report.scope.provenance.path,
            digest: report.scope.provenance.digest,
            entries: report.scope.provenance.entries
          }
        : null
    }
  }

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
    scopeAdherence: adherenceBlock,
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
