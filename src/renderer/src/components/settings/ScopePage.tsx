import { FieldGroup, Field, ListField, type ConfigState } from './SettingsShared'
import { CheckRow } from './CheckRow'
import { useEffect, useState } from 'react'
import { parseScopeInput } from '../../lib/scopeInput'
import { testScopeSubject, type ScopeTestResult } from '../../lib/scopeTest'

type Translate = (key: string, vars?: Record<string, string | number>) => string

function verdictLines(r: ScopeTestResult, t: Translate): { tone: 'good' | 'bad' | 'warn' | 'neutral'; lines: string[] } | null {
  switch (r.kind) {
    case 'empty': return null
    case 'unknown': return { tone: 'warn', lines: [t('settings.scopeTest.unknown')] }
    case 'unset': return { tone: 'neutral', lines: [t('settings.scopeTest.unset')] }
    case 'in-scope': return {
      tone: 'good',
      lines: [t('settings.scopeTest.inScope', { rule: r.matchedBy }), ...(r.viaWildcard ? [t('settings.scopeTest.inScopeWildcard')] : [])]
    }
    case 'excluded': return {
      tone: 'bad',
      lines: [t('settings.scopeTest.excluded', { rule: r.matchedBy }), ...(r.alsoIncluded ? [t('settings.scopeTest.excludedWins')] : [])]
    }
    case 'out-of-scope': return {
      tone: 'bad',
      lines: [
        t('settings.scopeTest.outOfScope'),
        ...(r.subdomainOf ? [t('settings.scopeTest.subdomain', { rule: r.subdomainOf })] : r.adjacentDomain ? [t('settings.scopeTest.adjacent')] : [])
      ]
    }
  }
}

const TONE: Record<'good' | 'bad' | 'warn' | 'neutral', string> = {
  good: 'text-emerald-500', bad: 'text-amber-400', warn: 'text-amber-400', neutral: 'text-redlog-text-dim'
}

/** Module scope, not inside ScopePage: a component declared in another's body
 *  is a new type every render and loses its input on each keystroke. */
type ScopeFileState = Awaited<ReturnType<Window['redlog']['scope']['fileInForce']>> | 'failed' | undefined

function ScopeTester({ targets, excludeTargets, t }: { targets: string[]; excludeTargets: string[]; t: Translate }): JSX.Element {
  const [input, setInput] = useState('')
  // The scope the app enforces is these lists PLUS the scope file. Testing the
  // lists alone called a host listed only in the file "out of scope", and an
  // empty list "no scope" while the file's scope was being enforced.
  const [file, setFile] = useState<ScopeFileState>(undefined)
  useEffect(() => {
    let live = true
    const read = (window as { redlog?: Window['redlog'] }).redlog?.scope?.fileInForce
    if (!read) return
    read().then((f) => { if (live) setFile(f) }).catch(() => { if (live) setFile('failed') })
    return () => { live = false }
  }, [])
  const fromFile = file && file !== 'failed' && file.ok ? file.entries : []
  const merged = [...targets, ...fromFile.filter((e) => !targets.includes(e))]
  const verdict = verdictLines(testScopeSubject(input, { targets: merged, excludeTargets }), t)
  return (
    <FieldGroup title={t('settings.scopeTest.title')}>
      <Field label={t('settings.scopeTest.label')} value={input} onChange={setInput} />
      <p className="text-xs text-redlog-text-faint">{t('settings.scopeTest.hint')}</p>
      {file === 'failed' && <p data-testid="scope-file-state" role="alert" className="text-xs text-amber-400">{t('settings.scopeTest.fileUnknown')}</p>}
      {file && file !== 'failed' && (
        <p data-testid="scope-file-state" role={file.ok && file.entries.length > 0 ? 'status' : 'alert'}
          className={`text-xs ${file.ok && file.entries.length > 0 ? 'text-redlog-text-faint' : 'text-amber-400'}`}>
          {!file.ok
            ? t(file.reason === 'invalid' ? 'settings.scopeTest.fileInvalid' : 'settings.scopeTest.fileUnreadable', { path: file.path })
            : file.entries.length === 0
              ? t('settings.scopeTest.fileEmpty', { path: file.path })
              : t('settings.scopeTest.fileRead', { count: file.entries.length })}
        </p>
      )}
      {verdict && (
        <div data-testid="scope-test-verdict" data-tone={verdict.tone} role="status" className={`text-xs space-y-1 ${TONE[verdict.tone]}`}>
          {verdict.lines.map((line) => <p key={line}>{line}</p>)}
        </div>
      )}
    </FieldGroup>
  )
}

export default function ScopePage({
  config, setConfig, t, candidate
}: {
  candidate?: string
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <>
      <FieldGroup title={t('settings.scopeEnforcement')}>
        <CheckRow
          checked={config.scope.warnOnViolation !== false}
          onChange={(on) => setConfig({ ...config, scope: { ...config.scope, warnOnViolation: on } })}
          label={t('settings.warnOnViolation')}
        />
        <p className="text-xs text-redlog-text-faint mt-1 leading-relaxed">{t('settings.warnOnViolationHint')}</p>
      </FieldGroup>
      <FieldGroup title={t('settings.inScopeTargets')}>
        <ListField
          key={candidate ?? 'no-candidate'}
          initialDraft={candidate}
          label={t('settings.targetsLabel')}
          items={config.scope.targets}
          onChange={(items) => setConfig({ ...config, scope: { ...config.scope, targets: items } })}
          placeholder={t('settings.targetsPlaceholder')}
          parse={parseScopeInput}
        />
        <p className="text-xs text-redlog-text-faint mt-1 leading-relaxed">{t('settings.scopeRulesHint')}</p>
      </FieldGroup>
      <FieldGroup title={t('settings.excludedTargets')}>
        <ListField
          label={t('settings.excludeLabel')}
          items={config.scope.excludeTargets}
          onChange={(items) => setConfig({ ...config, scope: { ...config.scope, excludeTargets: items } })}
          placeholder={t('settings.excludePlaceholder')}
          parse={parseScopeInput}
        />
      </FieldGroup>
      <ScopeTester targets={config.scope.targets} excludeTargets={config.scope.excludeTargets} t={t} />
      <FieldGroup title={t('settings.personalDomains')}>
        <ListField
          label={t('settings.personalDomainsLabel')}
          items={config.scope.personalDomains ?? []}
          onChange={(items) => setConfig({ ...config, scope: { ...config.scope, personalDomains: items } })}
          placeholder={t('settings.personalDomainsPlaceholder')}
        />
        <p className="text-xs text-redlog-text-faint mt-1 leading-relaxed">
          {t('settings.personalDomainsHint')}
        </p>
      </FieldGroup>
      <FieldGroup title={t('settings.scopeFile')}>
        <Field
          label={t('settings.scopeFileLabel')}
          value={config.scope.scopeFile || ''}
          onChange={(v) => setConfig({ ...config, scope: { ...config.scope, scopeFile: v } })}
        />
        <p className="text-xs text-redlog-text-faint">
          {t('settings.scopeFileHint')}
        </p>
      </FieldGroup>
    </>
  )
}
