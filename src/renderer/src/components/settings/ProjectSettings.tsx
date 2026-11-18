import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../../i18n'
import { toast } from '../Toast'
import { Button } from '../Button'
import { FieldGroup, Field, type ConfigState } from './SettingsShared'

export default function ProjectSettings({ config, setConfig }: { config: ConfigState; setConfig: (c: ConfigState) => void }): JSX.Element {
  const { t } = useI18n()
  // The project name is the one name: the title bar and the picker show it, so
  // this field renames the project rather than keeping a second name in config.
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [projectName, setProjectName] = useState('')
  // A rename answers after the field may have moved on, so the commit reads
  // the field and the project as they are now, not as its render saw them.
  const projectRef = useRef<{ id: string; name: string } | null>(null)
  const typed = useRef('')
  const showName = (v: string): void => { typed.current = v; setProjectName(v) }
  const storeProject = (p: { id: string; name: string }): void => { projectRef.current = p; setProject(p) }
  // Until the open project is read the field cannot rename anything, so a
  // failed read is said, not drawn as an empty editable name.
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setLoadFailed(false)
    window.redlog.project.active().then((p) => {
      if (live && p) { storeProject({ id: p.id, name: p.name ?? '' }); showName(p.name ?? '') }
    }, () => { if (live) setLoadFailed(true) })
    return () => { live = false }
  }, [loadAttempt])
  // A failed rename keeps what was typed and says it was not saved. Putting
  // the old name back without a word read as the input being dropped.
  const [renameError, setRenameError] = useState<string | null>(null)
  // One rename at a time. A commit asked for while one is in flight (the field
  // left again, or Retry) is held and sent when the first answers, so the
  // newer name is neither sent twice nor dropped.
  const renaming = useRef(false)
  const heldCommit = useRef(false)
  const commitProjectName = async (): Promise<void> => {
    if (renaming.current) { heldCommit.current = true; return }
    const project = projectRef.current
    const name = typed.current.trim()
    if (!project || !name || name === project.name) { showName(project?.name ?? ''); setRenameError(null); return }
    renaming.current = true
    let res: { ok: boolean; name?: string; error?: string }
    try {
      res = await window.redlog.project.rename(project.id, name)
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      renaming.current = false
    }
    const held = heldCommit.current
    heldCommit.current = false
    if (!res.ok) {
      // `rename-refused` is the main process's code, not words for the operator.
      // The field keeps whatever it holds now, which is what Retry sends.
      const why = res.error && res.error !== 'rename-refused' ? ` (${res.error})` : ''
      setRenameError(t('settings.projectRenameFailed') + why)
      return
    }
    const final = res.name ?? name
    setRenameError(null)
    storeProject({ ...project, name: final })
    window.dispatchEvent(new CustomEvent('redlog:project-renamed', { detail: final }))
    // Unchanged since it was sent: show the name as stored. Changed and left
    // again meanwhile: send the newer one. Changed and still being typed in:
    // leave it for its own commit.
    if (typed.current.trim() === name) showName(final)
    else if (held) await commitProjectName()
  }
  // The operator ID names a signer, and a save applies it to every source at
  // once. So it is committed when the field is left, not per keystroke (a
  // pause while typing would make an operator of each prefix), and never
  // blank (every capture would be refused, with no gap recorded).
  const [operatorId, setOperatorId] = useState(config.operator.id)
  useEffect(() => { setOperatorId(config.operator.id) }, [config.operator.id])
  const commitOperatorId = (): void => {
    const id = operatorId.trim()
    if (!id || id === config.operator.id) { setOperatorId(config.operator.id); return }
    setConfig({ ...config, operator: { ...config.operator, id } })
  }

  return (
    <>
      {/* Two IDs and two names, and the labels alone do not say which reach
          the record. The engagement ID and the operator ID are stamped on
          every event; the two names are display strings, and one of them
          quietly renames the project. That is on the ⓘ rather than under the
          field — four lines of prose here would bury the four inputs. */}
      <FieldGroup title={t('settings.engagement')}>
        <Field label={t('settings.id')} value={config.engagement.id} onChange={() => {}} readOnly hint={t('settings.engagementIdHint')} />
        <Field label={t('settings.name')} value={projectName} onChange={(v) => { showName(v); setRenameError(null) }} onBlur={() => { void commitProjectName() }} readOnly={!project} hint={t('settings.engagementNameHint')} error={renameError} />
        {renameError && <Button size="compact" level="quiet" className="self-start" onClick={() => { void commitProjectName() }}>{t('common.retry')}</Button>}
        {loadFailed && <div role="alert" className="text-xs text-redlog-danger">
          {t('settings.projectLoadFailed')} <Button size="compact" level="quiet" onClick={() => setLoadAttempt(n => n + 1)}>{t('common.retry')}</Button>
        </div>}
      </FieldGroup>
      <FieldGroup title={t('settings.operatorGroup')}>
        <Field label={t('settings.id')} value={operatorId} onChange={setOperatorId} onBlur={commitOperatorId} hint={t('settings.operatorIdHint')} />
        <Field label={t('settings.name')} value={config.operator.name} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, name: v } })} hint={t('settings.operatorNameHint')} />
      </FieldGroup>
      {/* Was "Team Profile Sync", two buttons. The import half duplicated
          the one on the project picker, which is where you actually want
          it — you seed a config when creating the project, not after.
          The export half stays: deleting it would leave an import that
          consumes files nothing can produce. */}
      <FieldGroup title={t('settings.handoffProfile')}>
        <Button size="compact"
          onClick={async () => {
            const p = await window.redlog.config.exportProfile()
            if (p) toast(t('toast.profileExported'), { type: 'success', why: p })
          }}
          className="self-start"
        >{t('settings.exportProfile')}</Button>
        <p className="text-xs text-redlog-text-faint">{t('settings.handoffProfileHint')}</p>
      </FieldGroup>
    </>
  )
}
