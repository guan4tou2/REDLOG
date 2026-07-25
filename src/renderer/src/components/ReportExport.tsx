import { useState } from 'react'

export function ReportExport(): JSX.Element {
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [format, setFormat] = useState<'json' | 'markdown'>('json')

  async function handleExport(): Promise<void> {
    setExporting(true)
    setResult(null)

    try {
      const [events, config, chainInfo, lootCount, violations] = await Promise.all([
        window.redlog.events.query({}),
        window.redlog.config.get(),
        window.redlog.chain.verify(),
        window.redlog.loot.getCount(),
        window.redlog.scope.getViolations()
      ])

      const report = {
        metadata: {
          exportedAt: new Date().toISOString(),
          config,
          evidenceChain: chainInfo,
          totalEvents: events.length,
          lootDetected: lootCount,
          scopeViolations: violations.length
        },
        events: events.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          agentType: e.agentType,
          targetId: e.targetId,
          data: e.data,
          hash: e.hash
        }))
      }

      if (format === 'json') {
        const blob = JSON.stringify(report, null, 2)
        downloadFile(blob, `redlog-export-${Date.now()}.json`, 'application/json')
      } else {
        const md = generateMarkdown(report, events)
        downloadFile(md, `redlog-report-${Date.now()}.md`, 'text/markdown')
      }

      setResult(`Exported ${events.length} events`)
    } catch (err) {
      setResult(`Export failed: ${err}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold text-white">Export Report</h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
        <div>
          <label className="text-zinc-400 text-sm block mb-1">Format</label>
          <div className="flex gap-2">
            {(['json', 'markdown'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`px-3 py-1 text-sm rounded ${
                  format === f ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {f === 'json' ? 'JSON' : 'Markdown'}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleExport}
          disabled={exporting}
          className="w-full py-2 bg-red-600 hover:bg-red-700 disabled:bg-zinc-700 text-white text-sm rounded transition-colors"
        >
          {exporting ? 'Exporting...' : 'Export Report'}
        </button>

        {result && (
          <div className="text-zinc-400 text-xs mt-2">{result}</div>
        )}
      </div>

      <div className="text-zinc-500 text-xs space-y-1">
        <p>JSON export includes all events, evidence chain status, and metadata.</p>
        <p>Markdown export generates a human-readable engagement report with timeline.</p>
      </div>
    </div>
  )
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function generateMarkdown(
  report: { metadata: Record<string, unknown> },
  events: RedLogEvent[]
): string {
  const meta = report.metadata
  const lines: string[] = [
    `# RedLog Engagement Report`,
    ``,
    `- **Exported**: ${meta.exportedAt}`,
    `- **Total Events**: ${meta.totalEvents}`,
    `- **Loot Detected**: ${meta.lootDetected}`,
    `- **Scope Violations**: ${meta.scopeViolations}`,
    `- **Evidence Chain**: ${(meta.evidenceChain as { valid: boolean }).valid ? 'Valid' : 'BROKEN'}`,
    ``,
    `## Timeline`,
    ``
  ]

  const byAgent = new Map<string, RedLogEvent[]>()
  for (const e of events) {
    const arr = byAgent.get(e.agentType) ?? []
    arr.push(e)
    byAgent.set(e.agentType, arr)
  }

  for (const [agent, evts] of byAgent) {
    lines.push(`### ${agent} (${evts.length} events)`)
    lines.push('')
    for (const e of evts.slice(0, 50)) {
      const time = new Date(e.timestamp).toLocaleTimeString()
      const summary = e.data?.command || e.data?.subtype || e.data?.title || ''
      lines.push(`- \`${time}\` ${summary}`)
    }
    if (evts.length > 50) lines.push(`- ... and ${evts.length - 50} more`)
    lines.push('')
  }

  return lines.join('\n')
}
