import type { BodySearchCoverage } from './http-body-index'
import type { RedLogEvent } from './db/event-types'
import type { EventQueryRequest, ToolSessionResolution } from './db/event-queries'

export type ActivityKind = 'command' | 'tool' | 'http' | 'message' | 'event'
export type ActivityState = 'call-only' | 'result-only' | 'paired' | 'interrupted' | 'conflicted' | 'unknown'
export type ActivityAction = 'command' | 'network' | 'conversation' | 'evidence' | 'security' | 'system' | 'other'
export type ToolAction = 'execute' | 'file-read' | 'file-write' | 'search' | 'browse' | 'custom' | 'unknown'

export interface ActivitySnapshot {
  chainedMaxRowId: number; loggedMaxRowId: number; takenAt: number
  chainedCount: number; loggedCount: number; chainedTailId: string | null; loggedTailId: string | null
}
export interface ActivityFilter {
  actions?: ActivityAction[]; providers?: string[]; sessions?: string[]
  states?: ActivityState[]; toolActions?: ToolAction[]
}
export interface ActivityRequest extends Omit<EventQueryRequest, 'snapshot'> {
  projectId: string
  snapshot?: ActivitySnapshot
  activityFilter?: ActivityFilter
}
export interface ActivityRef { id: string; key: string; projectId: string }
export interface ActivitySummary extends ActivityRef {
  kind: ActivityKind; state: ActivityState; action: ActivityAction; toolAction: ToolAction
  provider: string | null; sourceSession: string | null
  anchor: RedLogEvent; firstAt: number; lastAt: number
  matchedCount: number; sourceCount: number; contextCount: number
  matchedPreview: { ids: string[]; hasMore: boolean }
  sourcePreview: { ids: string[]; hasMore: boolean }
}
export interface ActivityPage {
  items: ActivitySummary[]; hasMore: boolean; nextCursor: string | null
  totalGroups: number; totalMatches: number; snapshot: ActivitySnapshot
  bodyCoverage?: BodySearchCoverage
  toolSession?: ToolSessionResolution
}
export interface ActivityMembersRequest extends Omit<ActivityRequest, 'limit' | 'cursor'> {
  ref: ActivityRef; snapshot: ActivitySnapshot; limit?: number; cursor?: string | null
  matchesFirst?: boolean
}
export interface ActivityMembersPage {
  items: Array<{ event: RedLogEvent; matched: boolean }>; hasMore: boolean; nextCursor: string | null
  sourceCount: number; matchedCount: number; snapshot: ActivitySnapshot
}
