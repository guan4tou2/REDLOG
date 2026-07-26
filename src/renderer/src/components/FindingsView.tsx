import { useState, useEffect, useCallback } from 'react'

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
const SEV_COLORS: Record<string, string> = {
  critical: 'bg-red-600',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
  info: 'bg-zinc-500'
}

export function FindingsView(): JSX.Element {
  const [findings, setFindings] = useState<Finding[]>([])
  const [selected, setSelected] = useState<Finding | null>(null)
  const [creating, setCreating] = useState(false)
  const [evidence, setEvidence] = useState<EvidenceLink[]>([])
  const [linkedEvents, setLinkedEvents] = useState<RedLogEvent[]>([])

  const refresh = useCallback(() => {
    window.redlog.findings.list().then(setFindings)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!selected) { setEvidence([]); setLinkedEvents([]); return }
    window.redlog.evidence.forFinding(selected.id).then((links) => {
      setEvidence(links)
      Promise.all(links.map((l) =>
        window.redlog.events.query({ limit: 1 }).then((all) =>
          all.find((e) => e.id === l.eventId) ?? null
        )
      ))
    })
  }, [selected])

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="w-72 border-r border-redlog-border flex flex-col">
        <div className="p-2 border-b border-redlog-border flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Findings ({findings.length})
          </span>
          <button
            onClick={() => { setCreating(true); setSelected(null) }}
            className="px-2 py-0.5 text-[10px] bg-redlog-accent/20 text-redlog-accent rounded hover:bg-redlog-accent/30"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {findings.map((f) => (
            <button
              key={f.id}
              onClick={() => { setSelected(f); setCreating(false) }}
              className={`w-full text-left px-3 py-2 border-b border-redlog-border hover:bg-zinc-800/50 ${
                selected?.id === f.id ? 'bg-zinc-800' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${SEV_COLORS[f.severity] ?? SEV_COLORS.info}`} />
                <span className="text-xs text-zinc-200 truncate">{f.title}</span>
              </div>
              <div className="text-[10px] text-zinc-500 mt-0.5 pl-4">
                {f.severity} · {f.status} · {new Date(f.updatedAt).toLocaleDateString()}
              </div>
            </button>
          ))}
          {findings.length === 0 && !creating && (
            <div className="p-4 text-xs text-zinc-600 text-center">No findings yet</div>
          )}
        </div>
      </div>

      {/* Detail / Create */}
      <div className="flex-1 overflow-auto p-4">
        {creating && <FindingForm onSave={() => { setCreating(false); refresh() }} onCancel={() => setCreating(false)} />}
        {selected && !creating && (
          <FindingDetail
            finding={selected}
            evidence={evidence}
            onUpdate={() => { refresh(); window.redlog.findings.get(selected.id).then((f) => f && setSelected(f)) }}
            onDelete={() => { setSelected(null); refresh() }}
          />
        )}
        {!selected && !creating && (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            Select a finding or create a new one
          </div>
        )}
      </div>
    </div>
  )
}

function FindingForm({ onSave, onCancel, initial }: {
  onSave: () => void
  onCancel: () => void
  initial?: Finding
}): JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [severity, setSeverity] = useState(initial?.severity ?? 'medium')
  const [cvssVector, setCvssVector] = useState(initial?.cvssVector ?? '')
  const [cvssScore, setCvssScore] = useState(initial?.cvssScore?.toString() ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [remediation, setRemediation] = useState(initial?.remediation ?? '')
  const [hosts, setHosts] = useState(initial?.affectedHosts?.join(', ') ?? '')

  const submit = async (): Promise<void> => {
    const data = {
      title,
      severity,
      cvssVector: cvssVector || undefined,
      cvssScore: cvssScore ? parseFloat(cvssScore) : undefined,
      description,
      remediation,
      affectedHosts: hosts ? hosts.split(',').map((h) => h.trim()).filter(Boolean) : []
    }
    if (initial) {
      await window.redlog.findings.update(initial.id, data)
    } else {
      await window.redlog.findings.create(data)
    }
    onSave()
  }

  return (
    <div className="space-y-3 max-w-xl">
      <h3 className="text-sm font-semibold text-zinc-300">{initial ? 'Edit Finding' : 'New Finding'}</h3>

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 focus:border-red-500 outline-none" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Severity</label>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}
            className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 outline-none">
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">CVSS Vector</label>
          <input value={cvssVector} onChange={(e) => setCvssVector(e.target.value)} placeholder="AV:N/AC:L/..."
            className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 outline-none" />
        </div>
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">CVSS Score</label>
          <input value={cvssScore} onChange={(e) => setCvssScore(e.target.value)} placeholder="7.5" type="number" step="0.1" min="0" max="10"
            className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 outline-none" />
        </div>
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 outline-none resize-y" />
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Remediation</label>
        <textarea value={remediation} onChange={(e) => setRemediation(e.target.value)} rows={2}
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 outline-none resize-y" />
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Affected Hosts (comma-separated)</label>
        <input value={hosts} onChange={(e) => setHosts(e.target.value)}
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 outline-none" />
      </div>

      <div className="flex gap-2 pt-1">
        <button onClick={submit} className="px-3 py-1.5 bg-redlog-accent text-white text-xs rounded hover:bg-red-700">
          {initial ? 'Update' : 'Create'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 bg-zinc-800 text-zinc-400 text-xs rounded hover:bg-zinc-700">
          Cancel
        </button>
      </div>
    </div>
  )
}

function FindingDetail({ finding, evidence, onUpdate, onDelete }: {
  finding: Finding
  evidence: EvidenceLink[]
  onUpdate: () => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [linkEventId, setLinkEventId] = useState('')

  if (editing) {
    return <FindingForm initial={finding} onSave={() => { setEditing(false); onUpdate() }} onCancel={() => setEditing(false)} />
  }

  const handleLink = async (): Promise<void> => {
    if (!linkEventId.trim()) return
    await window.redlog.evidence.link(finding.id, linkEventId.trim())
    setLinkEventId('')
    onUpdate()
  }

  const handleDelete = async (): Promise<void> => {
    await window.redlog.findings.delete(finding.id)
    onDelete()
  }

  const handleStatusChange = async (status: string): Promise<void> => {
    await window.redlog.findings.update(finding.id, { status })
    onUpdate()
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${SEV_COLORS[finding.severity] ?? SEV_COLORS.info}`} />
            <h3 className="text-base font-semibold text-zinc-200">{finding.title}</h3>
          </div>
          <div className="text-[10px] text-zinc-500 mt-1 flex gap-3">
            <span>{finding.severity}</span>
            {finding.cvssScore && <span>CVSS {finding.cvssScore}</span>}
            {finding.cvssVector && <span className="font-mono">{finding.cvssVector}</span>}
          </div>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setEditing(true)} className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700">Edit</button>
          <button onClick={handleDelete} className="px-2 py-1 text-[10px] bg-zinc-800 text-red-400 rounded hover:bg-zinc-700">Delete</button>
        </div>
      </div>

      <div className="flex gap-1">
        {['draft', 'confirmed', 'reported', 'fixed', 'wontfix'].map((s) => (
          <button key={s} onClick={() => handleStatusChange(s)}
            className={`px-2 py-0.5 text-[10px] rounded ${finding.status === s ? 'bg-redlog-accent text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}>
            {s}
          </button>
        ))}
      </div>

      {finding.description && (
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Description</label>
          <div className="mt-1 text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-900 rounded p-3 border border-zinc-800">{finding.description}</div>
        </div>
      )}

      {finding.remediation && (
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Remediation</label>
          <div className="mt-1 text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-900 rounded p-3 border border-zinc-800">{finding.remediation}</div>
        </div>
      )}

      {finding.affectedHosts.length > 0 && (
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Affected Hosts</label>
          <div className="mt-1 flex flex-wrap gap-1">
            {finding.affectedHosts.map((h) => (
              <span key={h} className="px-2 py-0.5 text-[10px] bg-zinc-800 text-zinc-300 rounded font-mono">{h}</span>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Linked Evidence ({evidence.length})</label>
        {evidence.map((link) => (
          <div key={link.id} className="flex items-center gap-2 mt-1 text-xs text-zinc-400 bg-zinc-900 rounded px-2 py-1 border border-zinc-800">
            <span className="font-mono text-zinc-500">{link.eventId.slice(0, 8)}...</span>
            {link.note && <span className="text-zinc-500">— {link.note}</span>}
            <button onClick={async () => { await window.redlog.evidence.unlink(link.id); onUpdate() }}
              className="ml-auto text-red-400 hover:text-red-300">×</button>
          </div>
        ))}
        <div className="flex gap-1 mt-2">
          <input value={linkEventId} onChange={(e) => setLinkEventId(e.target.value)} placeholder="Event ID"
            className="flex-1 px-2 py-1 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-200 outline-none font-mono" />
          <button onClick={handleLink} className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700">Link</button>
        </div>
      </div>
    </div>
  )
}
