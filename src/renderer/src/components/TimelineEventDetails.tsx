import { commandOutputState } from '../../../core/content-contract'
import { useReadState } from '../lib/readState'
import { EventContentReader, type ReaderControl } from './EventContentReader'
import { Button } from './Button'
// Structured detail-panel bodies for specific event types, pulled out of
// Timeline.tsx. Each renders in the inspector when its event type is selected.
// Reuses CollapsibleStream + MetadataGrid from HttpDetail for consistent
// expand/copy affordances.

import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { CollapsibleStream, MetadataGrid, HttpDetail, formatBytes, safePretty } from './HttpDetail'
import { toast } from './Toast'
import { summarizeLateOutput } from '../lib/lateOutput'

// ── Shell command_end ────────────────────────────────────────────────

interface BodyRef { sha256: string; size: number; file: string; encoding: 'text' | 'base64'; truncated?: boolean }

const asRef = (value: unknown): BodyRef | undefined => {
  const ref = value as BodyRef | undefined
  return ref && typeof ref.file === 'string' ? ref : undefined
}

/** What a command printed after its prompt came back — `sleep 30; echo done &`.
 *
 *  The relay keeps recording it as follow-up `command_output` rows tied to the
 *  command by id. Those rows are hidden from the list (they belong to the
 *  command, not beside it) and gathered here, so the record reads as one
 *  command with all of its output. Module scope for the same reason as above.
 */
function LateOutput({ commandId }: { commandId: string }): JSX.Element {
  const { t } = useI18n()
  const read = useReadState(() => window.redlog.events.commandOutput(commandId), true, [commandId])
  const rows = read.state.value
  useEffect(() => window.redlog.events.onNewBatch(read.retry), [commandId, read.retry])

  const { stdout, stderr, state, lateBytes, lostBytes: lost } = summarizeLateOutput(rows?.items ?? [], rows?.hasMore)
  const last = state !== 'running'
  const status = state === 'preview' ? t('timeline.detail.outputPreview')
    : state === 'incomplete' ? t('timeline.detail.lateTruncated')
    : state === 'done' ? t('timeline.detail.lateDone')
      : t('timeline.detail.lateRunning')

  return (
    <div className="space-y-1.5" data-testid="late-output">
      {read.state.phase === 'failed' && <div role="alert" className="text-xs text-amber-400">{t('content.status.failed')} <Button level="quiet" size="compact" onClick={read.retry}>{t('common.retry')}</Button></div>}
      <p className="text-xs text-redlog-text-dim font-mono">
        {t('timeline.detail.lateHeading')} · {status}
        {last && lateBytes > 0 ? ` · ${formatBytes(lateBytes)}` : ''}
        {last && lost > 0 ? ` · ${t('timeline.detail.lateLost', { bytes: formatBytes(lost) })}` : ''}
      </p>
      {stdout !== '' && (
        <CollapsibleStream label={t('timeline.detail.stdout')} content={stdout} accent="emerald" startOpen />
      )}
      {stderr !== '' && (
        <CollapsibleStream label={t('timeline.detail.stderr')} content={stderr} accent="amber" startOpen />
      )}
    </div>
  )
}

/** Said once on a command_start nothing has closed. Amber, not red: this is
 * "not known to have ended", and an old start may be an interrupted command. */
export function CommandUnfinishedNote(): JSX.Element {
  const { t } = useI18n()
  return (
    <p role="status" className="mt-2 text-xs text-amber-300">
      <strong className="font-semibold">{t('timeline.command.unfinished')}</strong> — {t('timeline.command.unfinishedHint')}
    </p>
  )
}

/** Structured detail body for a shell command_end event. */
export function CommandEndDetail({ data, projectId, eventId, reader }: {
  data: Record<string, unknown>; projectId: string; eventId: string
  /** Held by the Timeline so its bar can open the same Reader. */
  reader?: ReaderControl
}): JSX.Element {
  const { t } = useI18n()
  const [ownReaderOpen, setOwnReaderOpen] = useState(false)
  const readerOpen = reader ? reader.mode !== 'closed' : ownReaderOpen
  const setReaderOpen = (open: boolean): void => { if (reader) reader.setMode(open ? 'inline' : 'closed'); else setOwnReaderOpen(open) }
  const hasStdout = typeof data.stdout === 'string'
  const hasStderr = typeof data.stderr === 'string'
  const stdoutRef = asRef(data.stdout_ref)
  const stderrRef = asRef(data.stderr_ref)
  const hasStreamedOutput = (data.late_output === true || data.output_streamed === true) && typeof data.command_id === 'string'
  return (
    <div className="mt-2 space-y-1.5">
      {hasStdout && ((data.stdout as string).length > 0 || Number(data.stdout_bytes) > 0 || data.stdout_truncated === true) && (
        <CollapsibleStream
          label={t('timeline.detail.stdout')}
          content={data.stdout as string}
          bytes={typeof data.stdout_bytes === 'number' ? data.stdout_bytes : undefined}
          truncated={data.stdout_truncated === true}
          accent="emerald"
          startOpen={false}
        />
      )}

      {hasStderr && ((data.stderr as string).length > 0 || Number(data.stderr_bytes) > 0 || data.stderr_truncated === true) && (
        <CollapsibleStream
          label={t('timeline.detail.stderr')}
          content={data.stderr as string}
          bytes={typeof data.stderr_bytes === 'number' ? data.stderr_bytes : undefined}
          truncated={data.stderr_truncated === true}
          accent="amber"
          startOpen={false}
        />
      )}

      {(stdoutRef || stderrRef || readerOpen) && <>
        <Button size="compact" level="quiet" aria-expanded={readerOpen} onClick={() => setReaderOpen(!readerOpen)}>{t('content.savedContent')}</Button>
        {readerOpen && <EventContentReader projectId={projectId} eventId={eventId} {...(reader ? { expanded: reader.mode === 'expanded', onExpandedChange: (x: boolean) => reader.setMode(x ? 'expanded' : 'inline') } : {})} />}
      </>}
      {hasStreamedOutput && (
        <LateOutput commandId={data.command_id as string} />
      )}
      {/* v0.9.6 (T2/T3): say what happened to this command's output. */}
      {!hasStdout && !hasStderr && !stdoutRef && !stderrRef && !hasStreamedOutput && (
        <IoAbsenceNote
          builtin={data.source === 'builtin-terminal'}
          io={data.io as Record<string, unknown> | undefined}
        />
      )}
      <MetadataGrid
        entries={[
          ['exit_code', data.exit_code],
          ['duration_sec', data.duration_sec],
          ['cwd', data.cwd],
          ['pid', data.pid],
          ['terminal_id', data.terminalId ?? data.terminal_id],
          ['source', data.source],
          ['captured_by', data.captured_by]
        ]}
      />
    </div>
  )
}

// ── Operator-added evidence file ─────────────────────────────────────

/** A file the operator added: what it is, its hash, and where RedLog keeps its
 *  copy. "Show in folder" reveals that copy and never opens it — the file may
 *  be a sample the operator was handed. */
export function EvidenceFileDetail({ data }: { data: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const stored = typeof data.stored === 'string' && data.stored !== '' ? data.stored : null
  const original = typeof data.path === 'string' ? data.path : ''
  const reveal = async (): Promise<void> => {
    const ok = stored ? await window.redlog.artifacts.reveal('artifact', stored).catch(() => false) : false
    if (!ok) toast(t('artifacts.revealFailed'), { type: 'warning', why: t('artifacts.revealFailedWhy') })
  }
  return (
    <div className="mt-2 space-y-1.5" data-testid="evidence-file-detail">
      <MetadataGrid
        entries={[
          ['file', original.split(/[\\/]/).pop() || original],
          ['size', typeof data.size === 'number' ? formatBytes(data.size) : undefined],
          ['sha256', data.sha256],
          ['kept_as', stored],
          ['original_path', original],
          ['file_modified', typeof data.mtime === 'number' ? new Date(data.mtime).toISOString() : undefined],
          ['already_stored', data.duplicate === true ? 'yes' : undefined]
        ]}
      />
      {stored && (
        <button
          type="button"
          data-testid="evidence-file-reveal"
          onClick={() => void reveal()}
          className="text-xs text-redlog-cyan hover:text-redlog-text underline"
        >
          {t('artifacts.reveal')}
        </button>
      )}
    </div>
  )
}

// ── I/O absence note ─────────────────────────────────────────────────

/** v0.9.6 (T2): explains the absence — or the on-disk location — of a shell
 *  command's output, so an empty panel is never ambiguous. */
export function IoAbsenceNote({ builtin, io }: { builtin: boolean; io?: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const state = commandOutputState({ source: builtin ? 'builtin-terminal' : undefined, io })
  const len = typeof io?.len === 'number' ? (io.len as number) : 0

  if (state === 'recorded') {
    return (
      <p className="text-xs text-emerald-400/80 font-mono px-2 py-1 rounded border border-emerald-600/30 bg-emerald-900/10">
        {t('timeline.detail.ioOnDisk', { size: formatBytes(len) })}
      </p>
    )
  }
  if (state === 'empty') {
    return (
      <p className="text-xs text-redlog-text-dim font-mono px-2 py-1 rounded border border-redlog-border/60 bg-redlog-bg/40">
        {t('timeline.detail.ioNone')}
      </p>
    )
  }
  return (
    <p className="text-xs text-amber-400/80 font-mono px-2 py-1 rounded border border-amber-600/30 bg-amber-900/10">
      {t(state === 'unbracketed' ? 'timeline.detail.ioUnbracketed' : 'timeline.detail.ioNotCaptured')}
    </p>
  )
}

// ── Agent turn ───────────────────────────────────────────────────────

/** v0.9.2 U1: renders the payload of one `agent.*` event in the detail
 *  panel. Reuses CollapsibleStream + MetadataGrid so operators get the
 *  same expand/copy affordances they already know from shell events.
 *  v0.15: when a tool_call or tool_result is selected, `paired` carries the
 *  other half so both the request and its return read in one panel. */
export function AgentTurnDetail(
  { data, paired, allLoaded }: {
    data: Record<string, unknown>
    paired?: { kind: 'call' | 'result'; data: Record<string, unknown> }
    allLoaded?: boolean
  }
): JSX.Element {
  const { t } = useI18n()
  const subtype = String(data.subtype ?? '')
  const isMessage = subtype === 'user_message' || subtype === 'assistant_message'
  const isThinking = subtype === 'thinking'
  const isToolCall = subtype === 'tool_call'
  const isToolResult = subtype === 'tool_result'

  const bodyText = typeof data.full === 'string'
    ? (data.full as string)
    : (typeof data.preview === 'string' ? (data.preview as string) : '')
  const bodyBytes = typeof data.full_length === 'number' ? (data.full_length as number) : bodyText.length
  const bodyTruncated = data.truncated === true

  const toolInput = data.tool_input as Record<string, unknown> | undefined
  const toolInputStr = toolInput ? safePretty(toolInput) : ''

  const outputText = typeof data.output === 'string' ? (data.output as string) : ''
  const outputBytes = typeof data.output_length === 'number' ? (data.output_length as number) : outputText.length

  const pairedResultOut = paired?.kind === 'result' && typeof paired.data.output === 'string'
    ? (paired.data.output as string) : ''
  const pairedResultBytes = paired?.kind === 'result' && typeof paired.data.output_length === 'number'
    ? (paired.data.output_length as number) : pairedResultOut.length
  const pairedCallInput = paired?.kind === 'call'
    ? (paired.data.tool_input as Record<string, unknown> | undefined) : undefined
  const pairedCallStr = pairedCallInput ? safePretty(pairedCallInput) : ''

  return (
    <div className="mt-2 space-y-1.5">
      {(isMessage || isThinking) && bodyText.length > 0 && (
        <CollapsibleStream
          label={t(isThinking ? 'timeline.detail.agentThinking' : subtype === 'user_message' ? 'timeline.detail.agentUser' : 'timeline.detail.agentAssistant')}
          content={bodyText}
          bytes={bodyBytes}
          truncated={bodyTruncated}
          accent={subtype === 'user_message' ? 'emerald' : isThinking ? 'zinc' : 'amber'}
          startOpen={subtype === 'user_message'}
        />
      )}
      {isToolCall && (
        <CollapsibleStream
          label={t('timeline.detail.agentToolInput', { name: String(data.tool_name ?? 'tool') })}
          content={toolInputStr}
          accent="zinc"
          startOpen={false}
        />
      )}
      {isToolCall && paired?.kind === 'result' && pairedResultOut.length > 0 && (
        <>
          <CollapsibleStream
            label={t('timeline.detail.agentToolOutput')}
            content={pairedResultOut}
            bytes={pairedResultBytes}
            truncated={paired.data.truncated === true}
            accent="emerald"
            startOpen={true}
          />
        </>
      )}
      {isToolCall && !paired && allLoaded && (
        <p className="text-xs text-amber-400/80 font-mono px-1 py-0.5">⏳ {t('timeline.detail.toolNoResult')}</p>
      )}
      {isToolResult && paired?.kind === 'call' && pairedCallStr.length > 0 && (
        <CollapsibleStream
          label={t('timeline.detail.agentToolInput', { name: String(paired.data.tool_name ?? 'tool') })}
          content={pairedCallStr}
          accent="zinc"
          startOpen={false}
        />
      )}
      {isToolResult && outputText.length > 0 && (
        <CollapsibleStream
          label={t('timeline.detail.agentToolOutput')}
          content={outputText}
          bytes={outputBytes}
          truncated={data.truncated === true}
          accent="emerald"
          startOpen={false}
        />
      )}
      <MetadataGrid
        entries={[
          ['agent', data.agent],
          ['session_id', data.session_id],
          ['model', data.model],
          ['tool_use_id', data.tool_use_id],
          ['transcript_uuid', data.transcript_uuid],
          ['usage_tokens_in', data.usage_tokens_in],
          ['usage_tokens_out', data.usage_tokens_out],
          ['post_compact', data.post_compact === true ? 'true' : undefined],
          ['is_sidechain', data.is_sidechain === true ? 'true' : undefined]
        ]}
      />
    </div>
  )
}

// ── Scanner (HTTP proxy) ─────────────────────────────────────────────

// ── Browser console ──────────────────────────────────────────────────

/** v0.11.2 (T6): a captured browser console line. The stack is the reason this
 *  exists — a bare message rarely says where it came from. */
export function BrowserConsoleDetail({ data }: { data: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const message = typeof data.message === 'string' ? (data.message as string) : ''
  const stack = typeof data.stack_trace === 'string' ? (data.stack_trace as string) : ''
  const level = String(data.subtype ?? '')
  const accent = level === 'console_error' || level === 'exception' ? 'amber' : 'zinc'
  return (
    <div className="mt-2 space-y-1.5">
      {message.length > 0 && (
        <CollapsibleStream label={t('timeline.detail.consoleMessage')} content={message} accent={accent} startOpen />
      )}
      {stack.length > 0 && (
        <CollapsibleStream label={t('timeline.detail.consoleStack')} content={stack} accent="zinc" />
      )}
      <MetadataGrid
        entries={[
          ['level', level.replace(/^console_/, '')],
          ['source', data.source],
          ['line', data.line_number],
          ['url', data.url]
        ]}
      />
    </div>
  )
}

// ── Any other source ─────────────────────────────────────────────────

const GENERIC_MAX_FIELDS = 40
const GENERIC_MAX_VALUE = 500

function genericValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).length}}`
  const text = String(value)
  return text.length > GENERIC_MAX_VALUE ? `${text.slice(0, GENERIC_MAX_VALUE)}…` : text
}

/** The Reader for a source with no reader of its own (Spec 069 FR-007): the
 *  fields the event actually recorded, as text. Values are never interpreted,
 *  nested ones are only counted, and nothing here can throw on an odd shape. */
export function GenericEventDetail({ data }: { data: Record<string, unknown> | undefined }): JSX.Element {
  const { t } = useI18n()
  const entries = Object.entries(data ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return <></>
  return (
    <div className="mt-2" data-testid="generic-event-detail">
      <p className="mb-1 text-xs text-redlog-text-dim">{t('timeline.detail.genericFields')}</p>
      <MetadataGrid entries={entries.slice(0, GENERIC_MAX_FIELDS).map(([k, v]): [string, unknown] => [k, genericValue(v)])} />
      {entries.length > GENERIC_MAX_FIELDS && <p className="mt-1 text-xs text-redlog-text-dim">{t('timeline.detail.genericMore', { count: entries.length - GENERIC_MAX_FIELDS })}</p>}
    </div>
  )
}
