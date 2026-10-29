import fs from 'node:fs'
import path from 'node:path'
import type { HttpVerificationEvidence } from '../../core/http-verification-evidence'

/** Bounded local history; never an authority for restoring live verification. */
export class HttpVerificationHistory {
  read(projectDir: string): HttpVerificationEvidence[] {
    const file = path.join(projectDir, 'http-verification.json')
    try {
      if (fs.statSync(file).size > 128 * 1024) throw new Error('Verification history too large')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(value) || value.length > 20 || !value.every(valid)) throw new Error('Invalid verification history')
    return value
  }

  append(projectDir: string, evidence: HttpVerificationEvidence): void {
    if (!valid(evidence)) throw new Error('Invalid verification evidence')
    // Refuse to overwrite unreadable history. Persist no nonce, raw UA or URL
    // query: these records describe a local endpoint and a client family.
    const history = this.read(projectDir)
    const file = path.join(projectDir, 'http-verification.json')
    const temp = `${file}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify([...history, evidence].slice(-20)), { mode: 0o600 })
      fs.renameSync(temp, file)
    } finally {
      try { fs.unlinkSync(temp) } catch { /* renamed or not created */ }
    }
  }
}

function valid(value: unknown): value is HttpVerificationEvidence {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.version === 1 && v.captureVerified === true && typeof v.caTrustVerified === 'boolean'
    && typeof v.verifiedAt === 'number' && Number.isSafeInteger(v.verifiedAt) && v.verifiedAt > 0 && v.verifiedAt <= 8.64e15
    && (v.clientIdentity === null || (typeof v.clientIdentity === 'string' && v.clientIdentity.length <= 200))
    && ['projectId', 'clientLabel', 'endpoint', 'caFingerprint', 'routing', 'sourceInstance'].every(key => typeof v[key] === 'string' && (v[key] as string).length > 0 && (v[key] as string).length <= 2048)
}
