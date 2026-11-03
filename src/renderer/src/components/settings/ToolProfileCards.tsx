import { useRef } from 'react'
import type { CommandClass, PolicyEntry, PolicyProblem, PolicySource, TerminalProfile } from '../../../../core/terminal-class'
import type { EnvironmentDetection, ProfileDetection, ToolDetectionSnapshot } from '../../../../core/tool-detection'
import { useReadState } from '../../lib/readState'
import { useRevalidateOnFocus } from '../../hooks/useRevalidateOnFocus'
import { formatDateTime } from '../../lib/time'
import { Button } from '../Button'
import { FieldGroup } from './SettingsShared'

// #499 PR C, slice 1: one card per tool profile.
//
// A card says four things about a tool and keeps them apart, because the whole
// point is that no one of them stands in for another:
//   - the profile: whose it is (shipped, or a plugin's) and the one-line reason;
//   - detection: whether each environment's PATH had the executable. A miss is
//     "not found on PATH", a fact about a lookup. It changes nothing below it;
//   - the effective mode, from the compiler's entries: the policy class and where
//     it came from, then how that is actually captured and what it costs, as
//     separate lines. `pty` in bash is native, and the card says so;
//   - verification: nothing today carries it, so nothing is drawn.
//
// There is no switch, Start or Stop here. Recording is global, and a tool's mode
// is changed from the terminal until the override slice lands.
//
// Everything a plugin wrote (name, reason) is drawn as a text node, never as
// markup, and a profile that came out of a hand-edited file is checked for the
// types the compiler does not check.

type T = (key: string, vars?: Record<string, string | number>) => string

/** What the card list reads of `hooks:terminalPolicy`. All optional: a bridge
 *  from before profiles sends none of it, and the list is then simply absent. */
export interface ToolPolicyView {
  entries?: PolicyEntry[]
  problems?: PolicyProblem[]
  profiles?: TerminalProfile[]
}

interface Group { mode: CommandClass; source: PolicySource; profile?: string; commands: string[] }

const MODES: readonly CommandClass[] = ['native', 'pty', 'relayed']

/** Commands that share a mode and a source, in the order the compiler listed them. */
function groupEntries(entries: PolicyEntry[]): Group[] {
  const groups = new Map<string, Group>()
  for (const e of entries) {
    const key = `${e.mode}|${e.source}|${e.profile ?? ''}`
    const group = groups.get(key) ?? { mode: e.mode, source: e.source, profile: e.profile, commands: [] }
    groups.set(key, group)
    group.commands.push(e.command)
  }
  return [...groups.values()]
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function SourceLabel({ group, cardId, t }: { group: Group; cardId?: string; t: T }): JSX.Element {
  if (group.source === 'profile') {
    return <>{group.profile === cardId ? t('toolCard.source.profile') : t('toolCard.source.profileOther', { profile: group.profile ?? '' })}</>
  }
  return <>{t(`toolCard.source.${group.source}`)}</>
}

function Row({ label, testId, children }: { label: string; testId?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid min-w-0 gap-x-3 sm:grid-cols-[7rem_minmax(0,1fr)]" data-testid={testId}>
      <dt className="text-redlog-text-faint">{label}</dt>
      <dd className="min-w-0 break-words text-redlog-text-dim">{children}</dd>
    </div>
  )
}

function Commands({ names }: { names: string[] }): JSX.Element {
  return <>{names.map((n, i) => <span key={n}>{i > 0 && ' '}<code className="text-redlog-text">{n}</code></span>)}</>
}

function GroupLines({ groups, cardId, t }: { groups: Group[]; cardId?: string; t: T }): JSX.Element {
  return (
    <>
      {groups.map((g) => (
        <p key={`${g.mode}|${g.source}|${g.profile ?? ''}`}>
          <span className="text-redlog-text">{t(`toolCard.mode.${g.mode}`)}</span>
          {' · '}<SourceLabel group={g} cardId={cardId} t={t} />
          {': '}<Commands names={g.commands} />
        </p>
      ))}
    </>
  )
}

function environmentLabel(env: EnvironmentDetection, t: T): string {
  if (env.source === 'app') return t('toolCard.env.app')
  if (!env.shell) return t('toolCard.env.shellUnknown')
  return env.wslDistro
    ? t('toolCard.env.shellWsl', { shell: env.shell, distro: env.wslDistro })
    : t('toolCard.env.shell', { shell: env.shell })
}

function DetectionLine({ env, found, t }: { env: EnvironmentDetection; found: ProfileDetection | undefined; t: T }): JSX.Element {
  const state = found?.state ?? 'unchecked'
  const where = (found?.executables ?? []).flatMap((e) => (e.state === 'found' && e.path ? [e.path] : []))
  return (
    <p>
      <span className="text-redlog-text">{environmentLabel(env, t)}</span>
      {' · '}{t(`toolCard.detect.${state}`)}
      {where.length > 0 && <>{' · '}<code className="text-redlog-text">{where.join(', ')}</code></>}
      {' · '}{formatDateTime(env.detectedAt)}
      {env.stale && <>{' · '}<span className="text-amber-400">{t('toolCard.detect.stale')}</span></>}
    </p>
  )
}

function Detection({ id, snapshot, loading, t }: {
  id: string; snapshot: ToolDetectionSnapshot | null; loading: boolean; t: T
}): JSX.Element {
  const environments = snapshot?.environments ?? []
  return (
    <Row label={t('toolCard.detection')} testId={`tool-card-detection-${id}`}>
      {environments.length === 0
        ? <p>{loading ? t('common.loading') : t('toolCard.detect.unchecked')}</p>
        : environments.map((env) => (
          <DetectionLine key={env.id} env={env} found={env.profiles.find((p) => p.profile === id)} t={t} />
        ))}
    </Row>
  )
}

function Conflict({ problem, cardId, t }: {
  problem: Extract<PolicyProblem, { kind: 'conflict' }>; cardId: string; t: T
}): JSX.Element {
  const claims = problem.claims.map((c) => `${c.profile} (${t(`toolCard.mode.${c.mode}`)})`).join(', ')
  return (
    <p role="note" data-testid={`tool-card-conflict-${cardId}-${problem.command}`} className="text-amber-400">
      {t('toolCard.conflict', { command: problem.command, claims })}
      {' '}{problem.kept ? t('toolCard.conflictKept', { profile: problem.kept }) : t('toolCard.conflictNone')}
    </p>
  )
}

function ToolCard({ profile, entries, problems, snapshot, loading, t }: {
  profile: TerminalProfile
  entries: PolicyEntry[]
  problems: PolicyProblem[]
  snapshot: ToolDetectionSnapshot | null
  loading: boolean
  t: T
}): JSX.Element {
  const id = profile.id
  const name = text(profile.name) ?? id
  const reason = text(profile.reason)
  const slash = id.indexOf('/')
  const own = entries.filter((e) => profile.executables.includes(e.command))
  const groups = groupEntries(own)
  const modes = MODES.filter((m) => own.some((e) => e.mode === m))
  const conflicts = problems.filter((p): p is Extract<PolicyProblem, { kind: 'conflict' }> =>
    p.kind === 'conflict' && p.claims.some((c) => c.profile === id))
  return (
    <div role="group" aria-label={name} className="min-w-0 rounded border border-redlog-border bg-redlog-surface/50 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="break-words text-sm font-medium text-redlog-text">{name}</span>
        <code className="break-all text-xs text-redlog-text-faint">{id}</code>
        <span data-testid={`tool-card-origin-${id}`} className="text-xs text-redlog-text-dim">
          {slash === -1 ? t('toolCard.origin.shipped') : t('toolCard.origin.plugin', { plugin: id.slice(0, slash) })}
        </span>
      </div>
      {reason && <p className="mt-1 break-words text-xs text-redlog-text-dim">{reason}</p>}
      <dl className="mt-2 space-y-1.5 text-xs">
        <Detection id={id} snapshot={snapshot} loading={loading} t={t} />
        <Row label={t('toolCard.mode')} testId={`tool-card-mode-${id}`}>
          <GroupLines groups={groups} cardId={id} t={t} />
        </Row>
        <Row label={t('toolCard.capture')} testId={`tool-card-capture-${id}`}>
          {modes.map((m) => (
            <p key={m}>{modes.length > 1 && `${t(`toolCard.mode.${m}`)}: `}{t(`toolCard.capture.${m}`)}</p>
          ))}
        </Row>
        {modes.includes('pty') && (
          <Row label={t('toolCard.limits')} testId={`tool-card-limits-${id}`}>{t('toolCard.limits.pty')}</Row>
        )}
      </dl>
      {conflicts.length > 0 && (
        <div className="mt-2 space-y-1 text-xs">
          {conflicts.map((p) => <Conflict key={p.command} problem={p} cardId={id} t={t} />)}
        </div>
      )}
    </div>
  )
}

function problemText(p: PolicyProblem, t: T): string | null {
  switch (p.kind) {
    case 'invalid-profile': return t('toolCard.problem.invalidProfile', { profile: p.profile })
    case 'invalid-snapshot':
      return t(p.reason === 'unsupported-version' ? 'toolCard.problem.snapshotNewer' : 'toolCard.problem.snapshotUnreadable')
    case 'invalid-overlay': return t('toolCard.problem.overlayField', { field: p.field })
    case 'invalid-overlay-names': return t('toolCard.problem.overlayNames', { field: p.field })
    default: return null // a conflict is on the cards it names
  }
}

/** The card list, and the one place Settings asks for a lookup: once when it
 *  opens, and again only when the operator presses Rescan. Focus re-reads what
 *  is already known and looks nothing up. */
export function ToolProfileCards({ policy, t }: { policy: ToolPolicyView | null; t: T }): JSX.Element | null {
  // Optional: a running window's preload can predate the tools bridge.
  const bridge = (window.redlog as Partial<Window['redlog']> | undefined)?.tools
  // What the next read asks for. The first is the settings-open rescan; each
  // read consumes it, so a re-render or a focus return is a plain read.
  const next = useRef<'settings-open' | 'manual' | 'read'>('settings-open')
  const detection = useReadState(async (): Promise<ToolDetectionSnapshot | null> => {
    const how = next.current
    next.current = 'read'
    if (!bridge) return null
    return how === 'read' ? await bridge.detection() : await bridge.rescan(how)
  })
  useRevalidateOnFocus(detection.retry)

  const profiles = policy?.profiles ?? []
  if (profiles.length === 0) return null
  const entries = policy?.entries ?? []
  const problems = policy?.problems ?? []
  const loading = detection.state.phase === 'loading'
  const covered = new Set(profiles.flatMap((p) => p.executables))
  const others = groupEntries(entries.filter((e) => !covered.has(e.command)))
  const notes = problems.flatMap((p) => { const line = problemText(p, t); return line ? [line] : [] })

  return (
    <div className="mt-6">
      <FieldGroup title={t('settings.toolProfiles')}>
        <div data-testid="tool-profile-cards" className="space-y-3">
          {bridge && (
            <div className="flex justify-end">
              <Button size="compact" disabled={loading}
                onClick={() => { next.current = 'manual'; detection.retry() }}>
                {t('toolCard.rescan')}
              </Button>
            </div>
          )}
          {detection.state.phase === 'failed' && (
            <div role="alert" className="space-y-1 text-xs text-red-400">
              <p className="break-words">{detection.state.error}</p>
              <button type="button" className="min-h-8 underline" onClick={detection.retry}>{t('common.retry')}</button>
            </div>
          )}
          {notes.length > 0 && (
            <ul data-testid="tool-profile-problems" className="space-y-1 text-xs text-amber-400">
              {notes.map((line, i) => <li key={i} className="break-words">{line}</li>)}
            </ul>
          )}
          {profiles.map((profile) => (
            <ToolCard key={profile.id} profile={profile} entries={entries} problems={problems}
              snapshot={detection.state.value} loading={loading} t={t} />
          ))}
          {others.length > 0 && (
            <div data-testid="tool-profile-others" className="space-y-1 text-xs text-redlog-text-dim">
              <p className="text-redlog-text-faint">{t('toolCard.others')}</p>
              <GroupLines groups={others} t={t} />
            </div>
          )}
        </div>
        <p className="text-xs text-redlog-text-faint break-words">{t('settings.terminalClassEditedFromShell')}</p>
      </FieldGroup>
    </div>
  )
}
