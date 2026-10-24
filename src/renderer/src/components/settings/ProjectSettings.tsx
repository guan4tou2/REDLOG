import { useState, useEffect } from 'react'
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
  useEffect(() => {
    window.redlog.project.active().then((p) => {
      if (p) { setProject({ id: p.id, name: p.name ?? '' }); setProjectName(p.name ?? '') }
    }).catch(() => {})
  }, [])
  const commitProjectName = async (): Promise<void> => {
    const name = projectName.trim()
    if (!project || !name || name === project.name) { setProjectName(project?.name ?? ''); return }
    const res = await window.redlog.project.rename(project.id, name)
    const final = res.ok ? res.name ?? name : project.name
    setProject({ ...project, name: final })
    setProjectName(final)
    if (res.ok) window.dispatchEvent(new CustomEvent('redlog:project-renamed', { detail: final }))
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
        <Field label={t('settings.name')} value={projectName} onChange={setProjectName} onBlur={() => { void commitProjectName() }} hint={t('settings.engagementNameHint')} />
      </FieldGroup>
      <FieldGroup title={t('settings.operatorGroup')}>
        <Field label={t('settings.id')} value={config.operator.id} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, id: v } })} hint={t('settings.operatorIdHint')} />
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
