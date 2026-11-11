// node docs/records/2026-11-01/perf-audit-2026-11/run.mjs bench-event-delivery.ts -- baseline|worker [rows]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { writeApprovedEventExport } from '../../../../src/core/export-stream'
import { eventsToNdjson } from '../../../../src/core/ndjson-export'
import type { RedLogEvent } from '../../../../src/core/db/events'
async function run() {
  const [mode, rows = '198000'] = process.argv.slice(2)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-perf-'))
  const data = { output: 'x'.repeat(1024) }
  const events = Array.from({ length: Number(rows) }, (_, index) => ({ id: String(index), timestamp: index, data })) as RedLogEvent[]
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  const start = performance.now()
  try {
    const file = mode === 'worker' ? await writeApprovedEventExport(dir, 'ndjson', events, null, false, () => true) : path.join(dir, 'baseline.ndjson')
    if (mode !== 'worker') fs.writeFileSync(file, eventsToNdjson(events, { alreadyRedacted: true }))
    const elapsedMs = performance.now() - start
    clearInterval(timer)
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    console.log(JSON.stringify({ mode, rows: events.length, elapsedMs, timerTicks: ticks, bytes: fs.statSync(file).size, sha256: hash.digest('hex'), maxRssKiB: process.resourceUsage().maxRSS, platform: process.platform, node: process.version }))
  } finally { clearInterval(timer); fs.rmSync(dir, { recursive: true, force: true }) }
}
void run()
