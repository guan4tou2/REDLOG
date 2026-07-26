import { useState } from 'react'

export function ReportExport(): JSX.Element {
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [format, setFormat] = useState<'html' | 'json'>('html')

  async function handleExport(): Promise<void> {
    setExporting(true)
    setResult(null)

    try {
      const filePath = await window.redlog.report.export(format)
      if (filePath) {
        setResult(`Exported to: ${filePath}`)
      } else {
        setResult('Export failed: no active project')
      }
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
            {(['html', 'json'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`px-3 py-1 text-sm rounded ${
                  format === f ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {f.toUpperCase()}
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
          <div className="text-zinc-400 text-xs mt-2 font-mono break-all">{result}</div>
        )}
      </div>

      <div className="text-zinc-500 text-xs space-y-1">
        <p>HTML report includes findings, evidence chain status, event timeline, and engagement metadata.</p>
        <p>JSON export includes all events and metadata for external processing.</p>
        <p>Reports are saved to the project's reports/ directory.</p>
      </div>
    </div>
  )
}
