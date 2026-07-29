import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Capability } from './types'

// The trust store records, per privileged plugin, the exact content hash and
// capability set the operator consented to. A privileged plugin only runs when
// a grant exists AND its on-disk content hash still matches — so swapping in
// new code (or a manifest asking for more capabilities) silently revokes trust
// until the operator re-consents. This is the gate that keeps an audit tool
// from executing arbitrary third-party code against its own evidence log.

export interface TrustGrant {
  contentHash: string
  capabilities: Capability[]
  grantedAt: number
  /** operator id that approved it, for the audit trail */
  grantedBy?: string
}

type TrustStore = Record<string, TrustGrant>

function trustPath(): string {
  return join(homedir(), '.redlog', 'plugins', 'trust.json')
}

function read(): TrustStore {
  const p = trustPath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function write(store: TrustStore): void {
  const p = trustPath()
  mkdirSync(join(homedir(), '.redlog', 'plugins'), { recursive: true })
  writeFileSync(p, JSON.stringify(store, null, 2))
}

export function getGrant(pluginId: string): TrustGrant | null {
  return read()[pluginId] ?? null
}

/**
 * Is this plugin currently trusted to run its code?
 * Requires a grant whose pinned hash equals the current content hash AND whose
 * granted capabilities cover everything the manifest now requests.
 */
export function isTrusted(pluginId: string, contentHash: string, requested: Capability[]): boolean {
  const g = read()[pluginId]
  if (!g) return false
  if (g.contentHash !== contentHash) return false
  return requested.every((c) => g.capabilities.includes(c))
}

export function grant(pluginId: string, contentHash: string, capabilities: Capability[], grantedBy?: string): void {
  const store = read()
  store[pluginId] = { contentHash, capabilities, grantedAt: nowMs(), grantedBy }
  write(store)
}

export function revoke(pluginId: string): void {
  const store = read()
  if (store[pluginId]) {
    delete store[pluginId]
    write(store)
  }
}

// Date.now via an indirection so tests can hold time still if needed; the trust
// store itself never affects the event chain, so a wall clock is fine here.
function nowMs(): number {
  return Date.now()
}
