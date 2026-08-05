import { statSync } from 'fs'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { noteDbError } from '../../core/capture-health'

// ─────────────────────────────────────────────────────────────────────────────
// File watcher (v0.6.92)
//
// Opt-in producer for the `file_transfer` lane. When enabled, walks the
// configured `watchPaths` with chokidar and emits an event for each
// create / modify / delete event.
//
// Off by default because file activity in `/`, `~/`, or a large working tree
// is noisy — the operator has to explicitly narrow the scope. Sensible
// gitignore-style defaults are added to any user-supplied ignore list so
// `node_modules/`, `.git/`, `dist/` don't drown the timeline the moment the
// operator enables it on a source tree.
// ─────────────────────────────────────────────────────────────────────────────

// chokidar is CommonJS; the default export is a namespace with `.watch`.
// Loaded lazily so tests that don't import this file don't pay the require
// cost, and so a `chokidar-not-installed` scenario surfaces a friendly error
// at start-time rather than at import-time.
type ChokidarWatcher = {
  on: (event: string, cb: (path: string, stats?: unknown) => void) => ChokidarWatcher
  close: () => Promise<void>
}
type ChokidarNS = {
  watch: (paths: string | string[], opts: Record<string, unknown>) => ChokidarWatcher
}
let chokidarNS: ChokidarNS | null = null
function loadChokidar(): ChokidarNS | null {
  if (chokidarNS) return chokidarNS
  try { chokidarNS = require('chokidar') as ChokidarNS } catch { return null }
  return chokidarNS
}

export interface FileWatcherConfig {
  enabled: boolean
  watchPaths?: string[]
  ignorePatterns?: string[]
  engagementId: string
  operatorId: string
}

const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/.DS_Store',
  '**/*.swp',
  '**/*.swo',
  '**/*.tmp',
  '**/.#*',
  '**/.redlog/**',
]

let cfg: FileWatcherConfig = { enabled: false, engagementId: '', operatorId: '' }
let watcher: ChokidarWatcher | null = null

export function configureFileWatcher(next: Partial<FileWatcherConfig>): void {
  cfg = { ...cfg, ...next }
  restartFileWatcher()
}

export function startFileWatcher(next?: Partial<FileWatcherConfig>): void {
  if (next) cfg = { ...cfg, ...next }
  restartFileWatcher()
}

export function stopFileWatcher(): void {
  if (watcher) {
    watcher.close().catch(() => {})
    watcher = null
  }
}

function restartFileWatcher(): void {
  stopFileWatcher()
  if (!cfg.enabled) return
  if (!cfg.engagementId || !cfg.operatorId) return
  const paths = (cfg.watchPaths ?? []).filter(Boolean)
  if (paths.length === 0) return  // nothing configured — silent no-op
  const chok = loadChokidar()
  if (!chok) {
    console.warn('[file-watcher] chokidar not installed; skipping')
    return
  }
  const ignored = [...DEFAULT_IGNORES, ...(cfg.ignorePatterns ?? [])]
  try {
    watcher = chok.watch(paths, {
      ignored,
      persistent: true,
      ignoreInitial: true,          // don't emit for the tree that already exists
      followSymlinks: false,
      // awaitWriteFinish coalesces the "many partial writes → one save" case
      // an editor produces. 500ms matches the debounce window we advertise.
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      },
      // Depth limit stops a runaway watch on the whole home dir from
      // scanning every git repo. 8 covers most sensible workflow paths.
      depth: 8
    })
    watcher.on('add', (p) => emit(p, 'file_created'))
    watcher.on('change', (p) => emit(p, 'file_modified'))
    watcher.on('unlink', (p) => emit(p, 'file_deleted'))
    watcher.on('addDir', (p) => emit(p, 'file_created', true))
    watcher.on('unlinkDir', (p) => emit(p, 'file_deleted', true))
    watcher.on('error', () => { /* watcher self-recovers; ignore */ })
  } catch (e) {
    console.error('[file-watcher] failed to start:', e)
    watcher = null
  }
}

function emit(absPath: string, subtype: 'file_created' | 'file_modified' | 'file_deleted', isDir = false): void {
  if (eventBus.paused) return
  if (!cfg.engagementId || !cfg.operatorId) return
  let size: number | undefined
  let mtime: number | undefined
  if (subtype !== 'file_deleted') {
    try {
      const s = statSync(absPath)
      size = s.size
      mtime = s.mtimeMs
    } catch { /* just deleted between event + stat */ }
  }
  try {
    const ev = insertEvent('file_transfer', {
      subtype,
      path: absPath,
      size,
      mtime,
      is_dir: isDir || undefined,
      source: 'file-watcher'
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) {
    noteDbError('file-watcher', e)
  }
}

// Test seam — the pid-diff-style unit tests use this to inspect state
// without spinning up an actual watcher.
export function _getWatcherStateForTests(): { enabled: boolean; watching: boolean; watchPaths?: string[] } {
  return { enabled: cfg.enabled, watching: watcher !== null, watchPaths: cfg.watchPaths }
}
