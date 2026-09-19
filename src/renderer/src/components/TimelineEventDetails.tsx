// Structured detail-panel bodies for specific event types, pulled out of
// Timeline.tsx. Each renders in the inspector when its event type is selected.
// Reuses CollapsibleStream + MetadataGrid from HttpDetail for consistent
// expand/copy affordances.

import { useI18n } from '../i18n'
import { CollapsibleStream, MetadataGrid, HttpDetail, formatBytes, safePretty } from './HttpDetail'

// ── Shell command_end ────────────────────────────────────────────────

/** Structured detail body for a shell command_end event. Renders separate
 *  stdout / stderr collapsible sections when the wrapper populated them,
 *  falls back to a "mixed" section for the legacy `output` field, and
 *  finishes with a compact key=value metadata grid. */
export function CommandEndDetail({ data }: { data: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const hasStdout = typeof data.stdout === 'string'
  const hasStderr = typeof data.stderr === 'string'
  const hasLegacyOutput = !hasStdout && !hasStderr && typeof data.output === 'string'
  return (
    <div className="mt-2 space-y-1.5">
      {hasStdout && (
        <CollapsibleStream
          label={t('timeline.detail.stdout')}
          content={data.stdout as string}
          bytes={typeof data.stdout_bytes === 'number' ? data.stdout_bytes : undefined}
          truncated={data.stdout_truncated === true}
          accent="emerald"
          startOpen={false}
        />
      )}
      {hasStderr && (
        <CollapsibleStream
          label={t('timeline.detail.stderr')}
          content={data.stderr as string}
          bytes={typeof data.stderr_bytes === 'number' ? data.stderr_bytes : undefined}
          truncated={data.stderr_truncated === true}
          accent="amber"
          startOpen={false}
        />
      )}
      {hasLegacyOutput && (
        <CollapsibleStream
          label={t('timeline.detail.stdoutMixed')}
          content={data.output as string}
          accent="zinc"
          startOpen={false}
        />
      )}
      {/* v0.9.6 (T2/T3): say what happened to this command's output. */}
      {!hasStdout && !hasStderr && !hasLegacyOutput && (
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

// ── I/O absence note ─────────────────────────────────────────────────

/** v0.9.6 (T2): explains the absence — or the on-disk location — of a shell
 *  command's output, so an empty panel is never ambiguous. */
export function IoAbsenceNote({ builtin, io }: { builtin: boolean; io?: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const len = typeof io?.len === 'number' ? (io.len as number) : null
  const bracketed = len !== null && !io?.unbracketed

  if (bracketed && len > 0) {
    return (
      <p className="text-xs text-emerald-400/80 font-mono px-2 py-1 rounded border border-emerald-600/30 bg-emerald-900/10">
        {t('timeline.detail.ioOnDisk', { size: formatBytes(len) })}
      </p>
    )
  }
  if (bracketed && len === 0) {
    return (
      <p className="text-xs text-redlog-text-dim font-mono px-2 py-1 rounded border border-redlog-border/60 bg-redlog-bg/40">
        {t('timeline.detail.ioNone')}
      </p>
    )
  }
  return (
    <p className="text-xs text-amber-400/80 font-mono px-2 py-1 rounded border border-amber-600/30 bg-amber-900/10">
      {t(builtin ? 'timeline.detail.ioUnbracketed' : 'timeline.detail.ioNotCaptured')}
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

/** v0.11.2 (T6): alias — the actual component lives in HttpDetail.tsx now,
 *  shared with HttpHistoryPanel. */
export function ScannerDetail({ data, eventId }: { data: Record<string, unknown>; eventId: string }): JSX.Element {
  return <HttpDetail data={data} eventId={eventId} />
}

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
