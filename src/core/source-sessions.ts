import { createHash } from 'node:crypto'
import { getReadonlyDB } from './db/index'
import { readActivitySnapshot } from './db/dataset-snapshot'
import { sourceSessionKey } from './operation-pair-key'
import type { ActivitySnapshot } from './activity-contract'

export interface SourceSessionRequest {
  projectId: string
  kind: 'agent' | 'shell'
  provider?: string
  limit?: number
  cursor?: string | null
}
export interface SourceSession {
  projectId: string
  snapshot: ActivitySnapshot
  token: string
  source: string
  sessionId: string
  captureSessionId: string
  anchorEventId: string
  firstAt: number
  lastAt: number
  eventCount: number
}
export interface SourceSessionPage {
  snapshot: ActivitySnapshot
  items: SourceSession[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}
const registered = new WeakSet<object>()
const keyOf = (req: SourceSessionRequest): string => createHash('sha256').update(JSON.stringify([req.projectId,req.kind,req.provider ?? null])).digest('hex')

/** The token is a query reference, not an authorization capability. */
export function decodeSourceSession(token: string): string[] {
  try {
    if (typeof token !== 'string' || token.length > 16384 || Buffer.from(token,'base64url').toString('base64url') !== token) throw new Error()
    const tuple = JSON.parse(Buffer.from(token,'base64url').toString('utf8'))
    if (!Array.isArray(tuple) || tuple.length !== 6 || tuple[0] !== 'source1' || !['agent','shell'].includes(tuple[3]) || tuple.some(value=>typeof value!=='string'||!value)) throw new Error()
    return tuple
  } catch { throw new Error('Invalid source Session selection') }
}

/** Reads only this project's stored Events, never vendor conversation files. */
export function querySourceSessions(req: SourceSessionRequest): SourceSessionPage {
  if (!req || typeof req.projectId !== 'string' || !req.projectId || !['agent','shell'].includes(req.kind) || req.provider != null && (typeof req.provider !== 'string' || !req.provider)) throw new Error('Invalid source Session request')
  const limit=req.limit ?? 50
  if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('Invalid source Session limit')
  const db=getReadonlyDB(), q=keyOf(req)
  if(!registered.has(db)) {
    db.function('redlog_source_session_v1',{deterministic:true},(project,binding,agent,raw)=>sourceSessionKey({engagementId:String(project),sessionId:String(binding),agentType:String(agent),data:JSON.parse(String(raw))}))
    registered.add(db)
  }
  return db.transaction(()=>{
    let last='', lastAt=Number.MAX_SAFE_INTEGER, old: ActivitySnapshot | undefined
    if(req.cursor) {
      try {
        const cursor=JSON.parse(Buffer.from(req.cursor,'base64url').toString('utf8'))
        if(cursor.v!==1||cursor.q!==q||typeof cursor.last!=='string'||!cursor.last||!Number.isSafeInteger(cursor.lastAt)||!cursor.snapshot)throw new Error()
        last=cursor.last;lastAt=cursor.lastAt;old=cursor.snapshot
      } catch {throw new Error('Invalid source Session cursor or project')}
    }
    const snapshot=readActivitySnapshot(db,old)
    const rows=db.prepare(`WITH records AS (
      SELECT id,timestamp,engagement_id,session_id,agent_type,data FROM events WHERE engagement_id=? AND agent_type=? AND rowid<=?
      UNION ALL SELECT id,timestamp,engagement_id,session_id,agent_type,data FROM events_logged WHERE engagement_id=? AND agent_type=? AND rowid<=?
    ), keyed AS MATERIALIZED (
      SELECT *,redlog_source_session_v1(engagement_id,session_id,agent_type,data) AS sk FROM records
    ), sessions AS (
      SELECT sk,MIN(timestamp) AS firstAt,MAX(timestamp) AS lastAt,COUNT(*) AS eventCount,MIN(id) AS anchorId
      FROM keyed WHERE sk IS NOT NULL GROUP BY sk
    ), filtered AS (SELECT * FROM sessions ${req.provider ? "WHERE json_extract(sk,'$[4]')=?" : ''}),
    counted AS (SELECT *,COUNT(*) OVER() AS total FROM filtered)
    SELECT * FROM counted WHERE lastAt<? OR (lastAt=? AND sk>?) ORDER BY lastAt DESC,sk LIMIT ?`).all(req.projectId,req.kind,snapshot.chainedMaxRowId,req.projectId,req.kind,snapshot.loggedMaxRowId,...(req.provider ? [req.provider] : []),lastAt,lastAt,last,limit+1) as Array<{sk:string;firstAt:number;lastAt:number;eventCount:number;anchorId:string;total:number}>
    if(last && !rows.length) throw new Error('Source Session cursor no longer references a page')
    const hasMore=rows.length>limit, picked=rows.slice(0,limit)
    return {
      snapshot,
      items:picked.map(row=>{
        const tuple=JSON.parse(row.sk) as string[]
        return {projectId:req.projectId,snapshot,token:Buffer.from(row.sk).toString('base64url'),source:tuple[4],sessionId:tuple[5],captureSessionId:tuple[2],anchorEventId:row.anchorId,firstAt:row.firstAt,lastAt:row.lastAt,eventCount:row.eventCount}
      }),
      total:rows[0]?.total ?? 0,hasMore,
      nextCursor:hasMore ? Buffer.from(JSON.stringify({v:1,q,last:picked.at(-1)!.sk,lastAt:picked.at(-1)!.lastAt,snapshot})).toString('base64url') : null
    }
  })()
}
