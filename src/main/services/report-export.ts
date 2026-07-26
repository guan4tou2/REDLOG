import fs from 'fs'
import path from 'path'
import { queryEvents, getEventCount } from '../db/events'
import { getChainLength } from './evidence-chain'
import { getProjectDir } from '../db/index'

interface ReportMeta {
  engagementName: string
  operatorName: string
  generatedAt: string
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function buildHtmlReport(meta: ReportMeta): string {
  const events = queryEvents({ limit: 10000 })
  const eventCount = getEventCount()
  const chainLength = getChainLength()

  const agentCounts: Record<string, number> = {}
  for (const e of events) {
    agentCounts[e.agentType] = (agentCounts[e.agentType] || 0) + 1
  }

  const markers = events.filter((e) => e.agentType === 'marker')
  const scopeViolations = events.filter((e) => e.agentType === 'system' && e.data?.subtype === 'scope_violation')
  const loot = events.filter((e) => e.agentType === 'loot')
  const screenshots = events.filter((e) => e.agentType === 'screenshot')
  const timeRange = events.length > 0
    ? `${formatTimestamp(events[events.length - 1].timestamp)} — ${formatTimestamp(events[0].timestamp)}`
    : 'N/A'

  const rows = events.slice(0, 500).map((e) => `
    <tr>
      <td>${formatTimestamp(e.timestamp)}</td>
      <td><span class="badge badge-${e.agentType}">${escapeHtml(e.agentType)}</span></td>
      <td>${escapeHtml(e.targetId || '-')}</td>
      <td>${escapeHtml(JSON.stringify(e.data).slice(0, 200))}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RedLog Report — ${escapeHtml(meta.engagementName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 0 auto; padding: 2rem; background: #111; color: #eee; }
  h1 { color: #ef4444; border-bottom: 2px solid #ef4444; padding-bottom: 0.5rem; }
  h2 { color: #f87171; margin-top: 2rem; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
  .meta-card { background: #1a1a1a; padding: 1rem; border-radius: 8px; border: 1px solid #333; }
  .meta-card strong { color: #ef4444; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.85rem; }
  th, td { padding: 0.5rem; border: 1px solid #333; text-align: left; }
  th { background: #1a1a1a; color: #ef4444; }
  tr:nth-child(even) { background: #151515; }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .badge-marker { background: #ef4444; color: white; }
  .badge-terminal { background: #3b82f6; color: white; }
  .badge-clipboard { background: #8b5cf6; color: white; }
  .badge-screenshot { background: #10b981; color: white; }
  .badge-system { background: #6b7280; color: white; }
  .badge-loot { background: #f59e0b; color: black; }
  .badge-file_transfer { background: #06b6d4; color: white; }
  .stats { display: flex; gap: 1rem; flex-wrap: wrap; }
  .stat { background: #1a1a1a; padding: 1rem; border-radius: 8px; border: 1px solid #333; min-width: 120px; text-align: center; }
  .stat .num { font-size: 1.5rem; font-weight: bold; color: #ef4444; }
  .chain-ok { color: #10b981; }
  .chain-fail { color: #ef4444; }
  @media print { body { background: white; color: black; } th { background: #f3f3f3; color: #333; } .meta-card, .stat { background: #f9f9f9; border-color: #ccc; } }
</style>
</head>
<body>
<h1>RedLog Engagement Report</h1>
<div class="meta">
  <div class="meta-card"><strong>Engagement:</strong> ${escapeHtml(meta.engagementName)}</div>
  <div class="meta-card"><strong>Operator:</strong> ${escapeHtml(meta.operatorName)}</div>
  <div class="meta-card"><strong>Generated:</strong> ${escapeHtml(meta.generatedAt)}</div>
  <div class="meta-card"><strong>Time Range:</strong> ${timeRange}</div>
</div>

<h2>Summary</h2>
<div class="stats">
  <div class="stat"><div class="num">${eventCount}</div>Total Events</div>
  <div class="stat"><div class="num">${markers.length}</div>Markers</div>
  <div class="stat"><div class="num">${screenshots.length}</div>Screenshots</div>
  <div class="stat"><div class="num">${loot.length}</div>Loot Hits</div>
  <div class="stat"><div class="num">${scopeViolations.length}</div>Scope Violations</div>
  <div class="stat"><div class="num">${chainLength}</div>Chain Entries</div>
</div>

<h2>Evidence Integrity</h2>
<p>${chainLength} events with SHA-256 hashes</p>

<h2>Agent Breakdown</h2>
<table>
  <tr><th>Agent Type</th><th>Event Count</th></tr>
  ${Object.entries(agentCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<tr><td>${escapeHtml(t)}</td><td>${c}</td></tr>`).join('')}
</table>

${markers.length > 0 ? `
<h2>Markers / Findings</h2>
<table>
  <tr><th>Time</th><th>Title</th><th>Severity</th><th>Notes</th></tr>
  ${markers.map((m) => `<tr><td>${formatTimestamp(m.timestamp)}</td><td>${escapeHtml(String(m.data?.title || ''))}</td><td>${escapeHtml(String(m.data?.severity || 'info'))}</td><td>${escapeHtml(String(m.data?.notes || '').slice(0, 200))}</td></tr>`).join('')}
</table>` : ''}

${scopeViolations.length > 0 ? `
<h2>Scope Violations</h2>
<table>
  <tr><th>Time</th><th>Target</th><th>Command</th><th>Reason</th></tr>
  ${scopeViolations.slice(0, 50).map((v) => `<tr><td>${formatTimestamp(v.timestamp)}</td><td>${escapeHtml(String(v.data?.target || ''))}</td><td>${escapeHtml(String(v.data?.command || '').slice(0, 100))}</td><td>${escapeHtml(String(v.data?.reason || ''))}</td></tr>`).join('')}
</table>` : ''}

<h2>Event Log (first 500)</h2>
<table>
  <tr><th>Time</th><th>Agent</th><th>Target</th><th>Data</th></tr>
  ${rows}
</table>

<footer style="margin-top:2rem;color:#666;font-size:0.8rem;text-align:center;">
  Generated by RedLog v0.1.0 — ${escapeHtml(meta.generatedAt)}
</footer>
</body>
</html>`
}

export function exportReport(format: 'html' | 'json', meta: ReportMeta): string {
  const dir = path.join(getProjectDir(), 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  if (format === 'json') {
    const events = queryEvents({ limit: 100000 })
    const data = {
      meta,
      summary: { totalEvents: events.length, hashedEvents: getChainLength() },
      events
    }
    const filePath = path.join(dir, `report-${ts}.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  }

  const html = buildHtmlReport(meta)
  const filePath = path.join(dir, `report-${ts}.html`)
  fs.writeFileSync(filePath, html)
  return filePath
}
