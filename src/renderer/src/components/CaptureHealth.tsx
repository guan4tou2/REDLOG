import { useState, useEffect } from 'react'
import { Button } from './Button'
import { SectionLabel } from './SectionLabel'
import { computeCaptureReadiness, primaryCaptureAction, type CaptureAction } from '../lib/captureReadiness'
import { httpCaptureState, type HttpCaptureState } from '../lib/httpCaptureState'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { useTick } from '../lib/useTick'
import { clientLabel } from '../../../core/http-verify'
import { settingsTarget } from '../lib/navigation'
import { removeHookWithUndo } from '../lib/hookRemoval'
import { formatTime, formatDateTime } from '../lib/time'


/** What the `terminal` row says about the operator's OWN shell — three states,
 *  not two.
 *
 *  RedLog's panes always record, so the only open question on this row is
 *  whether the machine's other terminals are in the record too. "Installed"
 *  was being treated as the answer, and it is not one: a copied file and an
 *  appended rc line prove that a setup flow ran, not that anything is being
 *  captured. The rc has to be re-read, the adapter has to load, the transport
 *  has to reach RedLog — and the only evidence of all three is a command that
 *  arrived from a terminal that is not one of RedLog's (FR-015).
 */
function ownShellKey(s: { installed?: boolean; ownShellLastEventAt?: number | null; ownShellOutputAt?: number | null }): string {
  if (s.installed !== true) return 'capture.terminalOwnShellMissing'
  if (s.ownShellLastEventAt == null) return 'capture.terminalOwnShellPending'
  // Spec 060 FR-003: a command is not its output. "Included … and their
  // output" is said only once an output has actually been recorded.
  return s.ownShellOutputAt != null
    ? 'capture.terminalOwnShellIncluded'
    : 'capture.terminalOwnShellCommandOnly'
}

const SHELL_LABEL: Record<string, string> = { zsh: 'Zsh', bash: 'Bash', powershell: 'PowerShell' }

/** What the card heard and when, as facts. It says what arrived, not what will
 *  keep being recorded: a shell can be switched, an interactive tool can take
 *  the terminal, and a source can stop after the last thing it sent. */
function ownShellVars(s: { ownShellName?: string | null; ownShellLastEventAt?: number | null; ownShellOutputAt?: number | null }): Record<string, string> {
  return {
    shell: s.ownShellName ? (SHELL_LABEL[s.ownShellName] ?? s.ownShellName) : '',
    command: s.ownShellLastEventAt != null ? formatDateTime(s.ownShellLastEventAt) : '',
    output: s.ownShellOutputAt != null ? formatDateTime(s.ownShellOutputAt) : ''
  }
}

/** `127.0.0.1:6661` from the managed proxy's `http://127.0.0.1:6661`, only while
 *  it is running. */
function proxyListenAddress(proxy: { state: string; url?: string | null } | undefined): string | null {
  if (proxy?.state !== 'running' || !proxy.url) return null
  try { return new URL(proxy.url).host } catch { return proxy.url }
}

type Tone = 'ok' | 'warn' | 'err' | 'neutral' | 'off'
const TAG_TONE: Record<Tone, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  err: 'border-redlog-danger/50 bg-redlog-danger/10 text-red-300',
  neutral: 'border-redlog-border bg-redlog-elevated text-redlog-text-dim',
  off: 'border-redlog-border bg-redlog-elevated text-redlog-text-faint'
}
const LIGHT_TONE: Record<Tone, string> = {
  ok: 'bg-emerald-500', warn: 'bg-amber-500', err: 'bg-red-500', neutral: 'bg-redlog-text-faint', off: 'bg-redlog-elevated-hover'
}
function Tag({ tone, testid, children }: { tone: Tone; testid?: string; children: React.ReactNode }): JSX.Element {
  return <span data-testid={testid} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs [overflow-wrap:anywhere] ${TAG_TONE[tone]}`}>{children}</span>
}
function StatusLight({ tone, children }: { tone: Tone; children: React.ReactNode }): JSX.Element {
  return <span className="ml-auto flex items-center gap-1.5 text-xs text-redlog-text-dim">
    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${LIGHT_TONE[tone]}`} />{children}
  </span>
}

/** Whether commands can be recorded, and when one last arrived — the same four
 *  states as every inventory row. Separate from each other on purpose: an
 *  operator who has not typed for an hour has nothing wrong with capture. */
function coreCommandState(readiness: ReturnType<typeof computeCaptureReadiness>, sources: CaptureSourceInfo[]): {
  cmd: CaptureSourceInfo['state']; cmdLast: number | null; ownShell: CaptureSourceInfo | undefined
} {
  const commands = readiness.groups.find((g) => g.id === 'commands')
  const cmdSources = (commands?.steps ?? [])
    .map((s) => sources.find((x) => x.id === s.id))
    .filter((s): s is CaptureSourceInfo => s !== undefined)
  const cmd: CaptureSourceInfo['state'] =
    cmdSources.some((s) => s.state === 'ready') ? 'ready'
      : cmdSources.some((s) => s.state === 'error') ? 'error'
        : cmdSources.some((s) => s.state === 'off') ? 'off' : 'unset'
  const cmdLast = commands?.steps.reduce<number | null>((acc, s) => {
    const at = sources.find((x) => x.id === s.id)?.lastEventAt ?? null
    return at !== null && (acc === null || at > acc) ? at : acc
  }, null) ?? null
  return { cmd, cmdLast, ownShell: cmdSources.find((x) => x.id === 'terminal') }
}

/** Both core captures, always named, each with its own state. Commands is
 *  complete when a command source is active; HTTP(S) speaks the single HTTP
 *  vocabulary from httpCaptureState, and carries what the mitmproxy row used
 *  to say beneath it — that row is not repeated while this line is shown. */
function CoreCaptureLine({ readiness, http, listenAddress, source, sources, proxyError, unsavedGapEvents, verification, onNavigate, age, t }: {
  readiness: ReturnType<typeof computeCaptureReadiness>
  http: HttpCaptureState
  /** host:port the managed proxy is listening on, or null when it is not up (#254). */
  listenAddress: string | null
  source: CaptureSourceInfo | undefined
  sources: CaptureSourceInfo[]
  proxyError: string | undefined
  unsavedGapEvents: number | undefined
  verification: ManagedProxyStatus['httpsVerification']
  onNavigate: (target: string) => void
  /** "8m ago" for a timestamp, or an empty string for a source that has never
   *  recorded. Freshness is reported here as data, in its own column — it is
   *  what the removed `idle` state was a bad way of saying. */
  age: (ts: number | null) => string
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const { cmd, cmdLast, ownShell } = coreCommandState(readiness, sources)
  const verified = http === 'ready' && !!verification
  const httpWord = http === 'ready' ? t(verified ? 'capture.httpVerified' : 'capture.httpAwaitingTraffic') : t(`capture.http.${http}`)
  const cmdTone: Tone = cmd === 'ready' ? 'ok' : cmd === 'error' ? 'err' : 'off'
  const httpTone: Tone = verified ? 'ok' : http === 'ready' || http === 'starting' ? 'warn' : http === 'failed' ? 'err' : 'off'
  return (
    <ul data-testid="capture-core" className="text-xs">
      <li data-testid="capture-core-commands" data-state={cmd} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-redlog-border-subtle px-4 py-2 min-h-11">
        <button onClick={() => onNavigate(settingsTarget('hooks'))} className="w-28 shrink-0 min-h-8 text-left text-sm font-medium text-redlog-text hover:underline">{t('capture.group.commands')}</button>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {ownShell && <Tag tone="neutral">{ownShell.installed === true
            ? t('capture.tag.hookInstalled', { shell: ownShellVars(ownShell).shell || t('capture.tag.shell') })
            : t('capture.tag.hookMissing')}</Tag>}
          {cmd === 'ready' && <Tag tone="ok">{t('capture.tag.running')}</Tag>}
          {/* Installed is not recording (FR-015): what the operator's own shell
              has actually sent, beside the tags that say what is set up. */}
          {ownShell && (
            <span data-testid="capture-core-commands-own-shell" className="basis-full text-xs text-redlog-text-faint">
              {t(ownShellKey(ownShell), ownShellVars(ownShell))}
            </span>
          )}
        </span>
        <StatusLight tone={cmdTone}>{t(`capture.state.${cmd}`)}</StatusLight>
        <span data-testid="capture-core-commands-age" className="w-16 text-right font-mono tabular-nums text-redlog-text-faint">{age(cmdLast)}</span>
      </li>
      <li data-testid="capture-core-http" data-state={http} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 min-h-11">
        <button onClick={() => onNavigate(settingsTarget('browser'))} className="w-28 shrink-0 min-h-8 text-left text-sm font-medium text-redlog-text hover:underline">{t('capture.group.http')}</button>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {/* Where to point a tool (#254). */}
          {http === 'ready' && listenAddress && <Tag tone="neutral" testid="capture-core-http-address">{t('capture.http.listening', { address: listenAddress })}</Tag>}
          {http === 'ready' && <Tag tone={verified ? 'ok' : 'warn'} testid="capture-https-verification">
            {verified ? t('firstRun.http.verifiedVia', { client: clientLabel(verification!.userAgent) }) : t('capture.httpsUnverified')}
          </Tag>}
          {/* What it buys, while HTTP capture is not running. */}
          {(http === 'unset' || http === 'stopped') && <span className="basis-full text-xs text-redlog-text-faint">{t('capture.mitmproxyCapability')}</span>}
          {proxyError && <span className="basis-full text-red-400">{proxyError}</span>}
          {(unsavedGapEvents ?? 0) > 0 && (
            <span data-testid="capture-http-gap-unsaved" className="basis-full text-red-400">{t('capture.http.gapUnsaved', { count: unsavedGapEvents ?? 0 })}</span>
          )}
          {source?.lastError && <span className="basis-full text-red-400" title={source.lastError.message}>{source.lastError.message}</span>}
        </span>
        <StatusLight tone={httpTone}>{httpWord}</StatusLight>
        <span data-testid="capture-core-http-age" className="w-16 text-right font-mono tabular-nums text-redlog-text-faint">{age(source?.lastEventAt ?? null)}</span>
      </li>
    </ul>
  )
}

export function CaptureHealthCard({ capture, unknown, onNavigate, onRefresh, onSetup }: {
  capture: CaptureHealthInfo
  /** Set when the last read failed: what to say in place of a verdict. `capture`
   *  is then the last good snapshot, and the rows and controls below stay
   *  usable, but the headline and the "all good" line are not drawn. */
  unknown?: string
  onNavigate: (v: string) => void
  onRefresh: () => void
  onSetup?: () => void
}): JSX.Element {
  const { t } = useI18n()

  const SOURCE_LABEL: Record<string, string> = {
    'terminal': t('capture.terminal'),     // RedLog's panes + the operator's own shell
    'mitmproxy': t('capture.mitmproxy'),   // HTTP + DNS — one addon, one row
    'agent-claude-code': t('capture.agentClaudeCode'),
    'agent-codex': t('capture.agentCodex'),
    'screenshot': t('capture.screenshot'),
    'clipboard': t('capture.clipboard'),
    // v0.6.92 W-project producers.
    'browser-console': t('capture.browserConsole'),
    'process-monitor': t('capture.processMonitor'),
    'connection-monitor': t('capture.connectionMonitor'),
    'file-watcher': t('capture.fileWatcher')
  }
  // Green means it can record, red means it tried and failed, grey means it is
  // not set up or is switched off. No amber: amber used to mean "set up and
  // quiet", which is what a capture source looks like whenever its operator is
  // reading rather than typing.
  const dot = (s: string): string =>
    s === 'ready' ? 'bg-emerald-500'
      : s === 'error' ? 'bg-red-500' : 'bg-redlog-elevated-hover'

  // Same three colours as every other row: running, failed, or neither.
  const httpDot = (s: HttpCaptureState): string =>
    s === 'ready' ? 'bg-emerald-500'
      : s === 'failed' ? 'bg-red-500' : 'bg-redlog-elevated-hover'

  // v0.9.7: this card is an exception report, not an inventory. It used to
  // list all eight sources unconditionally, so the healthy majority pushed the
  // one broken row out of a glance — the opposite of what a "is anything
  // wrong?" panel is for. Default view now shows ONLY sources that the
  // operator switched on but that are not delivering; everything working, and
  // everything deliberately off, collapses into a one-line summary. `manage`
  // opens the full inventory with the controls.
  const [manage, setManage] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Hooks whose removal is waiting out its undo window, shown removed until
  // the health poll reports them gone (lib/hookRemoval.ts).
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const markRemoving = (hookId: string, on: boolean): void => setRemoving((prev) => {
    const next = new Set(prev)
    if (on) next.add(hookId)
    else next.delete(hookId)
    return next
  })
  useEffect(() => {
    setRemoving((prev) => {
      const still = [...prev].filter((id) => capture.sources.some((s) => s.hookId === id && s.installed === true))
      return still.length === prev.size ? prev : new Set(still)
    })
  }, [capture.sources])
  const sources = capture.sources.map((s) => (s.hookId && removing.has(s.hookId) ? { ...s, installed: false } : s))

  // "Switched off, and still writing to the record."
  //
  // The one combination that answers this card's audit question — is anything
  // capturing that I did not put there — with a yes. These producers run
  // outside RedLog under the operator's own sudo, so switching them off inside
  // RedLog never stopped them; it stopped RedLog mentioning them. Filed under
  // `informational` it was invisible by construction, because informational
  // rows are excluded from the compact view. It is not informational. It is
  // the fault.
  // Live, here, is about the PRODUCER, not the operator: a producer that is
  // heartbeating, or whose event landed moments ago, is writing to the record
  // right now. That is the one place a clock still belongs on this card, and
  // it is why removing `idle` costs nothing — "nobody typed for ten minutes"
  // and "something is writing that nobody authorised" are different questions.
  const ROGUE_WINDOW_MS = 10 * 60 * 1000
  const isRogue = (s: CaptureSourceInfo): boolean =>
    s.disabled === true &&
    (s.running === true || (s.lastEventAt !== null && capture.checkedAt - s.lastEventAt <= ROGUE_WINDOW_MS))

  // HTTP capture had two vocabularies on this card: the mitmproxy row's
  // active/idle/absent, and a separate line above it saying the managed proxy
  // was running. Both could be true at once and neither answered "is HTTP
  // being recorded". One derived state now drives the row's dot, its word and
  // its explanation, and the separate line is gone.
  const http = httpCaptureState(
    sources.find((s) => s.id === 'mitmproxy'),
    capture.managedHttpProxy
  )

  // "Something is wrong", and nothing else. A source that is switched off is a
  // choice; one that is not set up is a setup step the core line names; one
  // that is set up and quiet is an operator who is reading rather than typing,
  // which this card has no opinion about. What is left is what an exception
  // report is for: it tried and failed, or it is writing without authorisation.
  // A proxy that could not start is on the core line, with its reason.
  const isProblem = (s: CaptureSourceInfo): boolean =>
    isRogue(s) || (!s.informational && s.state === 'error')
  const problems = sources.filter(isProblem)
  const healthy = sources.filter((s) => s.state === 'ready')

  const setEnabled = async (s: CaptureSourceInfo, on: boolean): Promise<void> => {
    if (!s.configPath) return
    setBusy(s.id)
    try {
      const cfg = await window.redlog.config.get() as Record<string, unknown>
      // config:save replaces the whole doc, so mutating the fetched object in
      // place would be fine — a copy of only the branch we touch keeps this
      // honest if the bridge ever starts caching.
      const next = { ...cfg }
      const writeFlag = (path: string, value: boolean): void => {
        const parts = path.split('.')
        let cur = next as Record<string, unknown>
        for (const p of parts.slice(0, -1)) {
          cur[p] = { ...(cur[p] as Record<string, unknown> ?? {}) }
          cur = cur[p] as Record<string, unknown>
        }
        cur[parts[parts.length - 1]] = value
      }
      writeFlag(s.configPath, on)
      // A pack member is only on when its pack is too. Writing the member
      // alone would leave the operator flipping a switch and watching the row
      // stay `off` — a control reporting the opposite of what it just did.
      // Turning one OFF never touches the pack: the other members are not the
      // operator's to lose.
      if (on && s.packPath) writeFlag(s.packPath, true)
      await window.redlog.config.save(next)
      onRefresh()
    } finally { setBusy(null) }
  }

  const setInstalled = async (s: CaptureSourceInfo, install: boolean): Promise<void> => {
    if (!s.hookId) return
    if (!install) {
      const hookId = s.hookId
      removeHookWithUndo(hookId, t, {
        hide: () => markRemoving(hookId, true),
        restore: () => markRemoving(hookId, false),
        refresh: onRefresh
      })
      return
    }
    setBusy(s.id)
    try {
      const api = window.redlog.hooks
      const r = await api?.install(s.hookId)
      if (r && r.success === false) {
        toast(t('capture.actionFailed'), {
          type: 'error',
          why: t('capture.actionFailedWhy'),
          detail: r.message,
          action: { label: t('common.retry'), onClick: () => { void setInstalled(s, install) } }
        })
      }
      onRefresh()
    } finally { setBusy(null) }
  }
  const stateLabel = (s: string): string => t(`capture.state.${s}`)

  // v0.6.98 C: freshness stripe. Pre-v0.6.98 the state chip said only
  // "active / idle / absent" — an active source that hadn't fired in 45s
  // looked identical to one that fired 200ms ago. Now every source shows
  // "Ns ago" and the chip colour scales with age (green <60s, amber <5min,
  // zinc otherwise). Absent sources still show "—" — no lastEventAt to
  // format.
  // v0.6.99 B: tick every 1s so the ages advance smoothly. Pre-v0.6.99
  // the ages were computed against `capture.checkedAt` which only
  // refreshes on the 5s health poll — visually the label sat at "5s ago"
  // for 5 real seconds then jumped to "10s ago", which read as broken.
  // Now we compute against Date.now() at render time and force a rerender
  // once a second. Under-1-second precision doesn't matter for a
  // capture-freshness readout so cadence stays cheap.
  const nowTick = useTick()
  const fmtAge = (ts: number | null, now: number): string => {
    if (!ts) return '—'
    const sec = Math.max(0, Math.round((now - ts) / 1000))
    if (sec < 60) return `${sec}s ${t('capture.ago')}`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ${t('capture.ago')}`
    const hr = Math.round(min / 60)
    return `${hr}h ${t('capture.ago')}`
  }

  // A rogue source cannot leave the headline saying 健康. The core verdict
  // grades whether capture is WORKING; this grades whether it is AUTHORISED,
  // and a card that reports both has to let the worse one win, or it prints a
  // reassurance directly above the row that contradicts it.
  const rogue = sources.filter(isRogue)
  const dark = unknown === undefined && (capture.verdict === 'dark' || rogue.length > 0)
  const partial = unknown === undefined && capture.verdict === 'partial'
  // Pure + unit-tested in capture-readiness.ts; this card just renders it.
  // All that is left of it is the one next action — the checklist it used to
  // drive said the same two things as the core line above, in a third set of
  // words, and only while nothing had been recorded yet.
  const readiness = computeCaptureReadiness({ ...capture, sources })
  // One of the two core captures is named above and is not able to record.
  // The summary line below the rows must not then say everything is fine.
  const coreGap = http !== 'ready' || !capture.managedHttpProxy?.httpsVerification || sources.find((s) => s.id === 'terminal')?.state !== 'ready'
  // The core line always carries HTTP(S), so a mitmproxy row beneath it would
  // say the same thing twice. A rogue one stays: the core line has no word for
  // "switched off and still writing".
  const shown = manage ? sources : problems.filter((s) => s.id !== 'mitmproxy' || isRogue(s))

  // One action, when there is one.
  //
  // First: nothing has been recorded at all, and the terminal is the way to.
  // Installing the shell hook was deliberately NOT offered here, because
  // RedLog's own pane records with nothing installed — the install was a
  // second-order concern behind a "manage sources" click.
  //
  // Spec 052 changed what the install buys. The hook is now what brings the
  // operator's own terminals in, with their output, and an operator who works
  // in their own shell — which is most of them, most of the time — has a card
  // that says "healthy" about a machine whose real work is unrecorded. So
  // once there is a record at all, the remaining gap gets the card's one
  // action, and the action is the install itself rather than a trip to
  // Settings (FR-014).
  const terminalSource = sources.find((s) => s.id === 'terminal')
  const notEnrolled = !!terminalSource?.hookId && terminalSource.installed !== true
  const cta = readiness.nextStep !== null
    ? readiness.nextStep.status === 'todo'
      ? { label: t('capture.ctaOpenTerminal'), run: () => onNavigate('terminal') }
      : { label: t('capture.ctaRunCommand'), run: () => onNavigate('terminal') }
    : notEnrolled
      ? { label: t('capture.ctaInstallShellHook'), run: () => { void setInstalled(terminalSource!, true) } }
      : null
  const mitmSource = sources.find((s) => s.id === 'mitmproxy')
  // Healthy by verdict, but the HTTP proxy is listening and HTTPS has not been
  // verified: the line above says so in amber, and the headline must not say
  // plain "Recording" over it. Deliberately not every coreGap — an operator who
  // does not use the proxy would otherwise see an amber headline for good.
  const healthyGap = unknown === undefined && !dark && !partial && http === 'ready' && !capture.managedHttpProxy?.httpsVerification
  const barColor = unknown !== undefined ? 'bg-redlog-elevated-hover' : dark ? 'bg-redlog-danger' : partial || healthyGap ? 'bg-amber-500' : 'bg-emerald-500'
  // The badge: the verdict, in the worse of working and authorised.
  const headline = unknown !== undefined ? t('capture.readFailed')
    : rogue.length > 0 ? t('capture.rogueHeadline', { count: rogue.length })
    : dark ? t('capture.dark') : partial ? t('capture.partial') : healthyGap ? t('capture.healthyGap') : t('capture.healthy')
  const badgeTone: Tone = unknown !== undefined ? 'neutral' : dark ? 'err' : partial || healthyGap ? 'warn' : 'ok'
  const badgeGlyph = badgeTone === 'ok' ? '●' : badgeTone === 'neutral' ? '?' : '▲'
  // The title: what the two core captures can do right now, in one line. It
  // names each half, so "commands yes, HTTPS not yet" is never folded into a
  // single word that reads as either.
  const { cmd } = coreCommandState(readiness, sources)
  const httpsVerified = http === 'ready' && !!capture.managedHttpProxy?.httpsVerification
  const bothCore = cmd === 'ready' && httpsVerified
  const summary = unknown !== undefined ? t('capture.unknownTitle')
    : bothCore ? t('capture.summary.core')
    : t('capture.summary.compose', {
      cmd: t(`capture.summary.cmd.${cmd}`),
      http: t(http === 'ready' ? 'capture.summary.http.unverified' : `capture.summary.http.${http}`)
    })
  const subline = unknown !== undefined ? unknown : bothCore ? t('capture.sub.verified') : t('capture.sub.byReport')
  const footNote = unknown !== undefined ? ''
    : bothCore ? t('capture.lastChecked', { time: formatTime(capture.checkedAt) })
    : http === 'ready' && !httpsVerified ? t('capture.listeningIsNotTrust') : ''

  const inventory = (
    <div data-testid={manage ? 'capture-inventory' : 'capture-problems'} className={manage ? 'grid grid-cols-1 gap-y-1 px-4 py-2' : 'grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-redlog-border-subtle px-4 py-2'}>
      {shown.map((s) => {
        // The core line already says this about mitmproxy; the inventory
        // row keeps its state word and controls, not a second copy.
        const detail = s.id !== 'mitmproxy'
        return (
        <div key={s.id} data-testid={`capture-row-${s.id}`} className="flex items-center gap-2 text-xs">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.id === 'mitmproxy' ? httpDot(http) : dot(s.state)}`} />
          <span title={s.label ?? SOURCE_LABEL[s.id] ?? s.id} className={`flex-1 min-w-0 ${s.state === 'off' ? 'text-redlog-text-dim' : 'text-redlog-text'}`}>
            <span className="block truncate" title={s.label ?? SOURCE_LABEL[s.id] ?? s.id}>
              {s.label ?? SOURCE_LABEL[s.id] ?? s.id}
            </span>
            {/* The row says the capability; this says how far it reaches.
                RedLog's panes always record, so the only open question on
                this row is whether the operator's OWN terminal is in the
                record too — which is what the hook does, and the one thing
                here they can act on. */}
            {s.id === 'terminal' && (
              <span className="block text-xs text-redlog-text-faint">
                <span data-testid="own-shell-last">{t(ownShellKey(s), ownShellVars(s))}</span>
                {s.enrolled && s.enrolled.total > 0 && (
                  <span>{' · '}{t('capture.terminalEnrolled', {
                    recording: s.enrolled.recording, total: s.enrolled.total
                  })}</span>
                )}
              </span>
            )}
            {detail && s.id === 'mitmproxy' && capture.managedHttpProxy?.error && (
              <span className="block text-red-400">{capture.managedHttpProxy.error}</span>
            )}
            {s.informational && <span className="ml-1.5 text-redlog-text-faint text-xs uppercase tracking-wide">{t('capture.pluginTag')}</span>}
            {/* The operator believes they stopped this. They stopped
                RedLog talking about it; the producer is theirs, running
                under their own sudo, and only they can end it. Say where
                the teardown lives rather than leaving a red dot. */}
            {isRogue(s) && (
              <span data-testid={`capture-rogue-${s.id}`} className="block text-redlog-danger">
                {t('capture.rogueWhy')}
              </span>
            )}
            {/* Why it failed, not just that it did — the operator cannot
                act on a red dot alone. */}
            {detail && s.lastError && <span className="block text-red-400" title={s.lastError.message}>{s.lastError.message}</span>}

          </span>
          <span data-testid={`capture-state-${s.id}`} className="text-redlog-text-faint text-xs">
            {s.id === 'mitmproxy' ? t(`capture.http.${http}`) : stateLabel(s.state)}
          </span>
          {/* No colour on the age. It is a fact about the operator's last
              command, not a grade on the capture: a green "4s ago" that
              turns amber at five minutes is the quiet-is-a-fault idea
              coming back in through the stylesheet. */}
          {!manage && s.state !== 'unset' && s.state !== 'off' && (
            <span className="text-xs font-mono tabular-nums shrink-0 text-redlog-text-faint">
              {fmtAge(s.lastEventAt, nowTick)}
            </span>
          )}
          {manage && (
            <span className="flex items-center gap-1.5 shrink-0">
              {/* Two independent axes, so two controls. A hook can be
                  installed but switched off, or switched on but not yet
                  installed — collapsing them into one button would hide
                  which half is missing. */}
              {(() => {
                // §17: both axes stay visible, but exactly one control is
                // drawn as the primary — the operator should not have to
                // work out which button moves them forward when the state
                // already determines it.
                const primary = primaryCaptureAction(s)
                const emphasis = (mine: CaptureAction): string =>
                  primary === mine
                    ? 'border-redlog-accent/60 text-redlog-accent hover:bg-redlog-accent/10'
                    : 'border-redlog-border text-redlog-text-dim hover:text-redlog-text'
                return (
                  <>
                    {s.configPath && (
                      <button
                        disabled={busy === s.id}
                        onClick={() => void setEnabled(s, s.enabled === false)}
                        className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${emphasis('enable')}`}
                      >
                        {s.enabled === false ? t('capture.turnOn') : t('capture.turnOff')}
                      </button>
                    )}
                    {s.hookId && (
                      <button
                        disabled={busy === s.id}
                        onClick={() => void setInstalled(s, s.installed !== true)}
                        className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 ${emphasis('install')}`}
                      >
                        {s.installed === true ? t('capture.uninstall') : t('capture.install')}
                      </button>
                    )}
                  </>
                )
              })()}
              {/* No switch and nothing to install: these turn on when
                  their upstream does (mitmproxy in DNS mode, the launched
                  browser, a terminal pane). Claiming "always on" would
                  overstate it, so the state column speaks for itself. */}
              {!s.configPath && !s.hookId && s.id.startsWith('agent-') && (
                <button onClick={() => onNavigate(settingsTarget('captureControl'))} className="text-xs text-redlog-text-dim underline">{t('settings.agents')}</button>
              )}
              {!s.configPath && !s.hookId && !s.id.startsWith('agent-') && (
                <span className="text-xs font-mono text-redlog-text-faint">{t('capture.passive')}</span>
              )}
            </span>
          )}
        </div>
        )
      })}
    </div>
  )

  return (
    <section>
      <SectionLabel className="tracking-[0.15em] mb-3">{t('capture.title')}</SectionLabel>
      {/* §4: card ground is always surface — state is carried by the colour
          block beside the title and the badge, and (for the danger 'dark'
          verdict only) a red-tinted border. */}
      <div data-testid="capture-card" className={`rounded-lg border shadow-card overflow-hidden bg-redlog-surface ${
        dark ? 'border-red-900/60' : 'border-redlog-border'
      }`}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-redlog-border-subtle px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span aria-hidden className={`mt-0.5 h-8 w-[3px] shrink-0 rounded-full ${barColor}`} />
            <div className="min-w-0">
              <strong data-testid="capture-summary" className="block text-sm font-semibold text-redlog-text">{summary}</strong>
              <p data-testid={unknown !== undefined ? 'capture-unknown' : 'capture-subline'} className="mt-0.5 text-xs text-redlog-text-dim">{subline}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={badgeTone} testid="capture-verdict"><span aria-hidden>{badgeGlyph}</span><span>{headline}</span></Tag>
            {unknown !== undefined && <Button size="compact" data-testid="capture-unknown-retry" onClick={onRefresh}>{t('capture.reread')}</Button>}
          </div>
        </div>
        {/* #217: both core captures, always named. */}
        <CoreCaptureLine
          readiness={readiness}
          http={http}
          verification={capture.managedHttpProxy?.httpsVerification}
          onNavigate={onNavigate}
          listenAddress={proxyListenAddress(capture.managedHttpProxy)}
          source={mitmSource}
          sources={sources}
          proxyError={capture.managedHttpProxy?.error}
          unsavedGapEvents={capture.managedHttpProxy?.unsavedGapEvents}
          age={(ts) => (ts === null ? '' : fmtAge(ts, nowTick))}
          t={t}
        />
        {cta && (
          <div className="flex items-center gap-3 border-t border-redlog-border-subtle px-4 py-2">
            <Button size="compact" level="quiet" disabled={busy !== null} onClick={cta.run}>{cta.label}</Button>
            <button onClick={() => onNavigate(settingsTarget('hooks'))} className="text-xs text-redlog-text-dim hover:text-redlog-text underline">
              {t('capture.openHooks')}
            </button>
          </div>
        )}
        {/* An exception stays in view with the list folded: a source that
            failed, or one writing while switched off, is not "other". */}
        {!manage && shown.length > 0 && inventory}
        {/* No chain/logged footer. It restated the status bar's tier count,
            and its drift warning was a third copy of one the event tile and
            the issues list already raise. */}
        {/* The record had write gaps earlier in this session.
            `lastDbError` expires after a minute so the verdict can recover on
            its own, which is right for "is writing broken NOW" and wrong for
            an audit tool: an engagement that lost rows at 14:02 still lost
            them at 18:00. The counter is the one thing on this card that
            never clears. */}
        {capture.dbErrorTotal > 0 && (
          <div data-testid="capture-db-gaps" className="border-t border-redlog-border-subtle px-4 py-2 flex items-center gap-2 text-xs">
            <span className="text-redlog-danger">!</span>
            <span className="text-redlog-text-dim">
              {t('capture.dbGaps', {
                count: capture.dbErrorTotal,
                since: capture.dbErrorFirstAt ? formatTime(capture.dbErrorFirstAt) : ''
              })}
            </span>
          </div>
        )}
        <div data-testid="capture-footer" className="flex flex-wrap items-center justify-between gap-2 border-t border-redlog-border-subtle bg-redlog-bg px-4 py-2 text-xs text-redlog-text-faint">
          <span>{footNote}</span>
          {onSetup && <Button size="compact" data-testid="capture-open-setup" onClick={onSetup}>{t('capture.openSetup')}</Button>}
        </div>
        <div className="border-t border-redlog-border-subtle px-4">
          <button
            data-testid="capture-more-sources"
            aria-expanded={manage}
            onClick={() => setManage((m) => !m)}
            className="min-h-9 w-full text-left text-xs font-medium text-redlog-text-dim hover:text-redlog-text"
            title={t('capture.auditHint')}
          >
            {t('capture.manageWithHidden', { count: sources.length })} <span aria-hidden>{manage ? '▴' : '▾'}</span>
          </button>
        </div>
        {manage && <>
          {inventory}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-redlog-border-subtle bg-redlog-bg px-4 py-2">
            <span className="text-xs text-redlog-text-faint">{t('capture.manageNote')}</span>
            <Button size="compact" level="quiet" data-testid="capture-manage-sources" onClick={() => onNavigate(settingsTarget('captureControl'))}>{t('capture.manageSources')}</Button>
          </div>
        </>}
      </div>
    </section>
  )
}
