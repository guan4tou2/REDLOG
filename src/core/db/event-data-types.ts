import type { RedLogEvent } from './event-types'

// ── Shell ────────────────────────────────────────────────────────────

export interface ShellCommandData {
  subtype: 'command'
  command: string
  cwd?: string
  exitCode?: number
  exit_code?: number
  source?: string
}

export interface ShellCommandStartData {
  subtype: 'command_start'
  command: string
  cwd?: string
  terminalId?: string
  source?: string
}

export interface ShellCommandEndData {
  subtype: 'command_end'
  command?: string
  exitCode?: number
  exit_code?: number
  terminalId?: string
  durationMs?: number
}

export interface ShellSessionStartData {
  subtype: 'session_start'
  terminalId?: string
  shell?: string
}

export interface ShellSessionEndData {
  subtype: 'session_end'
  terminalId?: string
  durationMs?: number
}

export type ShellEventData =
  | ShellCommandData
  | ShellCommandStartData
  | ShellCommandEndData
  | ShellSessionStartData
  | ShellSessionEndData

// ── Marker ───────────────────────────────────────────────────────────

export interface MarkerOriginalData {
  title: string
  notes?: string
  severity?: string
  category?: string
  atTimestamp?: number
  url?: string
  source?: string
  redactions?: unknown[]
}

export interface MarkerAmendmentData {
  subtype: 'amended'
  markerId: string
  title?: string
  notes?: string
  severity?: string
  category?: string
}

export type MarkerEventData = MarkerOriginalData | MarkerAmendmentData

// ── System ───────────────────────────────────────────────────────────

export interface SystemRecordingPausedData {
  subtype: 'recording_paused'
  source?: string
}

export interface SystemRecordingResumedData {
  subtype: 'recording_resumed'
  source?: string
}

export interface SystemScopeViolationData {
  subtype: 'scope_violation'
  target?: string
  description?: string
  _causes?: string[]
}

export interface SystemScopeClearedData {
  subtype: 'scope_cleared'
  violation_id?: string
}

export interface SystemScopeRecomputedData {
  subtype: 'scope_recomputed'
  added?: number
  removed?: number
}

export interface SystemScreenshotDeletedData {
  subtype: 'screenshot_deleted'
  source_event: string
  _causes?: string[]
  path?: string
  sha256_pre_delete?: string | null
}

export interface SystemSecretRevealedData {
  subtype: 'secret_revealed'
  source_event: string
  fields: string[]
}

export interface SystemConfigChangedData {
  subtype: 'config_changed'
  diff?: Record<string, unknown>
}

export interface SystemBrowserLaunchedData {
  subtype: 'browser_launched'
  binary?: string
  proxy?: string | null
  cdpPort?: number
  isolatedProfile?: boolean
  pid?: number
}

export type SystemEventData =
  | SystemRecordingPausedData
  | SystemRecordingResumedData
  | SystemScopeViolationData
  | SystemScopeClearedData
  | SystemScopeRecomputedData
  | SystemScreenshotDeletedData
  | SystemSecretRevealedData
  | SystemConfigChangedData
  | SystemBrowserLaunchedData
  | { subtype: string; [key: string]: unknown }

// ── Scanner ──────────────────────────────────────────────────────────

export interface ScannerHttpResponseData {
  subtype: 'http_response'
  method?: string
  url?: string
  host?: string
  status?: number
  duration_ms?: number
  size?: number
  remote_addr?: string
  remote_port?: number
}

export interface ScannerHttpRequestStartData {
  subtype: 'http_request_start'
  method?: string
  url?: string
  host?: string
}

export interface ScannerConnectionData {
  subtype: 'connection' | 'connection_end'
  remote_addr?: string
  remote_port?: number
  proto?: string
  domain?: string
}

export type ScannerEventData =
  | ScannerHttpResponseData
  | ScannerHttpRequestStartData
  | ScannerConnectionData
  | { subtype: string; [key: string]: unknown }

// ── DNS ──────────────────────────────────────────────────────────────

export interface DnsEventData {
  subtype?: 'dns_response'
  query_name?: string
  query_type?: string
  answers?: unknown[]
  duration_ms?: number
  response_code?: string
  dest_host?: string
}

// ── Screenshot ───────────────────────────────────────────────────────

export interface ScreenshotEventData {
  filename?: string
  trigger?: string
  sha256?: string
}

// ── Credential ───────────────────────────────────────────────────────

export interface CredentialUseEventData {
  subtype?: string
  user_context?: string
  scheme?: string
  dest_host?: string
  dest_ip?: string
  masked?: boolean
}

// ── Type guards ──────────────────────────────────────────────────────
// These narrow both agentType and data in one check, so the consumer
// gets typed access to data fields without inline casts.

type TypedEvent<A extends string, D> = RedLogEvent & { agentType: A; data: D }

export function isShellEvent(e: RedLogEvent): e is TypedEvent<'shell', ShellEventData> {
  return e.agentType === 'shell'
}

export function isMarkerEvent(e: RedLogEvent): e is TypedEvent<'marker', MarkerEventData> {
  return e.agentType === 'marker'
}

export function isSystemEvent(e: RedLogEvent): e is TypedEvent<'system', SystemEventData> {
  return e.agentType === 'system'
}

export function isScannerEvent(e: RedLogEvent): e is TypedEvent<'scanner', ScannerEventData> {
  return e.agentType === 'scanner'
}

export function isDnsEvent(e: RedLogEvent): e is TypedEvent<'dns', DnsEventData> {
  return e.agentType === 'dns'
}

export function isScreenshotEvent(e: RedLogEvent): e is TypedEvent<'screenshot', ScreenshotEventData> {
  return e.agentType === 'screenshot'
}

export function isCredentialEvent(e: RedLogEvent): e is TypedEvent<'credential_use', CredentialUseEventData> {
  return e.agentType === 'credential_use'
}

export function hasSubtype<S extends string>(
  data: Record<string, unknown>,
  subtype: S
): data is Record<string, unknown> & { subtype: S } {
  return data.subtype === subtype
}
