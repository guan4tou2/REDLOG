import type { ProvenanceCounts } from '../../src/core/evidence-rules'

/** The receiver-provenance counts tools/redlog-verify.py printed, as the
 *  app's verifier returns them (BundleVerdict.provenance); null when it
 *  printed no report. Without an events_logged.jsonl the logged counts are 0,
 *  as they are on the app's side. */
export function pythonProvenance(stdout: string): ProvenanceCounts | null {
  const chained = /^Receiver stamp\s+: events\.jsonl: (\d+) proven, (\d+) self-described, (\d+) cannot be determined$/m.exec(stdout)
  if (!chained) return null
  const logged = /^\s+events_logged\.jsonl: (\d+) self-described(?: \((\d+) stamped, not protected row by row\))?, (\d+) cannot be determined$/m.exec(stdout)
  return {
    chained: { proven: Number(chained[1]), selfDescribed: Number(chained[2]), undetermined: Number(chained[3]) },
    logged: { selfDescribed: Number(logged?.[1] ?? 0), stamped: Number(logged?.[2] ?? 0), undetermined: Number(logged?.[3] ?? 0) }
  }
}

/** The provenance block as printed, for comparing wording. Python's text-mode
 *  stdout ends a line with \r\n on Windows; the wording is what is compared,
 *  so either ending splits. */
export function pythonProvenanceBlock(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/)
  const at = lines.findIndex((l) => l.startsWith('Receiver stamp'))
  if (at < 0) return []
  const end = lines.findIndex((l, i) => i > at && !l.startsWith(' '))
  return lines.slice(at, end < 0 ? undefined : end)
}
