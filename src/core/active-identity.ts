import path from 'node:path'
import { mkdirPrivate, writePrivateFileAtomic } from './private-fs'

// ~/.redlog/active-identity.json: which project and operator the shell hooks
// and the HTTP addon stamp what they capture with. Every hook reads it on every
// event (shell-common.sh), and the spool keeps whatever it said.

export interface ActiveIdentity { engagementId: string; operatorId: string }

/** Rewrite the identity file so that a reader finds the old identity or the new
 *  one, never part of either (Spec 071 FR-013). Throws when it could not be
 *  written; the old file is then untouched. */
export function writeActiveIdentity(file: string, { engagementId, operatorId }: ActiveIdentity): void {
  mkdirPrivate(path.dirname(file))
  writePrivateFileAtomic(file, JSON.stringify({ engagementId, operatorId }))
}
