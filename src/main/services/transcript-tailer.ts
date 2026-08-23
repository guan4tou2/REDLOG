import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { homedir } from 'os'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { noteDbError } from '../../core/capture-health'
import { parseStartTranscript, type TranscriptCommand } from '../../core/start-transcript'

// PowerShell Start-Transcript follower (docs/DESIGN-core-and-capture.md §2.3).
//
// The design's decision for thin Windows capture: PowerShell writes a full
// session transcript (start-transcript-hook.ps1), and RedLog follows it —
// exactly the agent-tailer shape, something else writes a file and we read it.
// The parsing risk lives in src/core/start-transcript.ts (unit-tested); this
// service is the file-follow and the emit.
//
// It watches ~/.redlog/transcripts/*.txt and, on each change, re-parses the
// file and emits shell command events for the commands it has not emitted yet.
// Re-parsing the whole file each time (rather than byte-tailing) is the simple
// correct choice: Start-Transcript rewrites cleanly, a transcript is one
// session's worth of commands, and per-file emit bookkeeping (below) makes the
// repeat idempotent. The alternative — tracking byte offsets into a file whose
// last command's output is still growing — is the kind of incremental state
// that goes subtly wrong and fabricates or drops a command, which §2.2 forbids.

export interface TranscriptTailerConfig {
  enabled: boolean
  engagementId: string
  operatorId: string
}

type ChokidarWatcher = {
  on: (event: string, cb: (p: string) => void) => ChokidarWatcher
  close: () => Promise<void>
}
type ChokidarNS = { watch: (paths: string | string[], opts: Record<string, unknown>) => ChokidarWatcher }
let chokidarNS: ChokidarNS | null = null
function loadChokidar(): ChokidarNS | null {
  if (chokidarNS) return chokidarNS
  try { chokidarNS = require('chokidar') as ChokidarNS } catch { return null }
  return chokidarNS
}

let cfg: TranscriptTailerConfig = { enabled: false, engagementId: '', operatorId: '' }
let watcher: ChokidarWatcher | null = null
/** Per-file count of commands already emitted, so a re-parse emits only the new
 *  ones. Keyed by absolute transcript path. */
const emitted = new Map<string, number>()

function transcriptDir(): string {
  return path.join(homedir(), '.redlog', 'transcripts')
}

export function configureTranscriptTailer(next: Partial<TranscriptTailerConfig>): void {
  cfg = { ...cfg, ...next }
  restart()
}

export function stopTranscriptTailer(): void {
  if (watcher) { void watcher.close(); watcher = null }
  emitted.clear()
}

function restart(): void {
  if (watcher) { void watcher.close(); watcher = null }
  emitted.clear()
  if (!cfg.enabled) return
  const chok = loadChokidar()
  if (!chok) { console.warn('[transcript-tailer] chokidar not installed; skipping'); return }

  const dir = transcriptDir()
  // Seed emitted-counts from the transcripts already on disk WITHOUT emitting:
  // those sessions predate this capture being turned on, the same reasoning
  // the connection monitor uses for connections open at launch.
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue
      const full = path.join(dir, name)
      try { emitted.set(full, parseStartTranscript(readFileSync(full, 'utf-8')).commands.length) }
      catch { /* unreadable — will retry on change */ }
    }
  } catch { /* dir absent until the hook runs — chokidar still watches it */ }

  try {
    watcher = chok.watch(path.join(dir, '*.txt'), {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    })
    watcher.on('add', (p) => follow(p))
    watcher.on('change', (p) => follow(p))
    watcher.on('error', () => { /* self-recovers */ })
  } catch (e) {
    console.error('[transcript-tailer] failed to start:', e)
    watcher = null
  }
}

function follow(absPath: string): void {
  if (eventBus.paused) return
  if (!cfg.engagementId || !cfg.operatorId) return
  let text: string
  try { text = readFileSync(absPath, 'utf-8') } catch { return }
  const parsed = parseStartTranscript(text)
  const already = emitted.get(absPath) ?? 0
  const fresh = parsed.commands.slice(already)
  if (fresh.length === 0) return
  for (const c of fresh) emitCommand(absPath, c, parsed.host)
  emitted.set(absPath, parsed.commands.length)
}

const OUTPUT_CAP = 100 * 1024  // parity with the shell hook's per-stream cap

function emitCommand(sourcePath: string, cmd: TranscriptCommand, host: string | null): void {
  try {
    const ev = insertEvent('shell', {
      subtype: 'command_end',
      source: 'start-transcript',
      command: cmd.command,
      cwd: cmd.cwd,
      ...(cmd.output ? { output_preview: cmd.output.slice(0, OUTPUT_CAP) } : {}),
      ...(host ? { hostname: host } : {}),
      transcript: path.basename(sourcePath)
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('transcript-tailer', e) }
}

/** Test seam: the pure incremental decision — given a transcript's full text
 *  and how many commands were already emitted, which are new and what is the
 *  new count. The follow() side effect is a thin wrapper over this. */
export function planTranscriptEmit(text: string, alreadyEmitted: number): {
  fresh: TranscriptCommand[]
  newCount: number
} {
  const parsed = parseStartTranscript(text)
  return { fresh: parsed.commands.slice(alreadyEmitted), newCount: parsed.commands.length }
}
