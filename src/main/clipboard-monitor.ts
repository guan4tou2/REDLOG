import { clipboard } from 'electron'
import { createHash } from 'crypto'
import { ingestEvent } from '../core/ingest'
import { eventBus } from '../core/event-bus'
import { noteDbError } from '../core/capture-health'
import { redact, maskText, getRules } from '../core/redaction'
import type { LootDetector } from '../core/loot-detector'

// Clipboard capture is off by default — the clipboard often holds passwords,
// tokens, session cookies. When enabled, we:
//   • poll (Electron has no clipboard-change event)
//   • hash the raw text (SHA-256) so evidence chains can prove "this content was
//     seen at time X" without needing to store the raw value
//   • run the loot detector — credentials get their own loot event; the raw
//     credential value is never stored on the clipboard event itself
//   • run redaction on any preview before storage (opt-in via storePreview)
//   • dedupe consecutive identical clipboard states by hash (repeated read of
//     the same value is one event, not one per poll)

interface Config {
  enabled: boolean
  pollMs: number
  storePreview: boolean
  engagementId: string
  operatorId: string
  lootDetector: LootDetector | null
}

let cfg: Config = { enabled: false, pollMs: 1500, storePreview: false, engagementId: '', operatorId: '', lootDetector: null }
let timer: ReturnType<typeof setInterval> | null = null
let lastHash: string | null = null
// Bumped by every restart and stop. config:save and project open configure the
// monitor more than once in one synchronous run, and each restart awaits the
// clipboard before arming the poll: without this, every restart that got past
// the `enabled` check armed its own timer, the earlier ones leaked, and turning
// the pack off left capture running (TESTING.md G-CB2). Only the newest
// restart may arm the poll.
let generation = 0

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function sample(): Promise<void> {
  // Recording paused → skip ambient clipboard capture entirely. Only
  // gate ambient/background capture here; user-driven writes (markers,
  // session boundaries) go through their own IPC and always land.
  // Off is checked here too, so no timer can capture after the pack is off.
  if (!cfg.enabled || eventBus.paused) return
  let text: string
  try { text = await clipboard.readText() } catch { return }
  if (!text) return
  const hash = sha256(text)
  if (hash === lastHash) return
  lastHash = hash
  // Clipboard is a special case in the four-layer model: even for evidence
  // integrity we DON'T want raw clipboard text on disk (credentials pasted
  // through clipboard are the user's biggest exposure). Detect spans via
  // redact() but store the MASKED preview — clipboard events skip layers 3+4
  // and mask at capture time. Full text never lands.
  const rules = getRules()
  const previewRaw = text.slice(0, 120)
  const redacted = redact(previewRaw, rules)
  const preview = cfg.storePreview ? maskText(previewRaw, redacted.redacted) : null
  // Loot detector emits its OWN 'loot' event when it finds a credential — the
  // clipboard event just records that clipboard state changed. This keeps
  // credential-detection semantics identical to command-output detection.
  let lootTypes: string[] = []
  if (cfg.lootDetector) {
    try {
      const matches = cfg.lootDetector.scan(text, undefined, 'clipboard')
      lootTypes = matches.map((m) => m.type)
    } catch { /* additive */ }
  }
  try {
    ingestEvent('clipboard', {
      subtype: 'clipboard_changed',
      sha256: hash,
      length: text.length,
      lines: text.split('\n').length,
      lootTypes: lootTypes.length > 0 ? lootTypes : undefined,
      preview,  // null when storePreview is off
      redactionsInPreview: redacted.redacted.length > 0 ? redacted.redacted.length : undefined
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
  } catch (e) {
    // DB may not be ready during startup or project close; forward to
    // capture-health so a persistent failure surfaces on StatusBar instead of
    // silently swallowing (v0.6.86).
    noteDbError('clipboard', e)
  }
}

export function configureClipboardMonitor(next: Partial<Config>): void {
  cfg = { ...cfg, ...next }
  restart()
}

export function startClipboardMonitor(): void { restart() }

export function stopClipboardMonitor(): void {
  generation++
  if (timer) { clearInterval(timer); timer = null }
  lastHash = null
}

async function restart(): Promise<void> {
  const run = ++generation
  if (timer) { clearInterval(timer); timer = null }
  if (!cfg.enabled) return
  // Seed lastHash so the first poll doesn't emit an event for whatever was on
  // the clipboard before RedLog opened — that's out-of-scope for this session.
  let seed: string | null
  try { seed = sha256((await clipboard.readText()) || '') } catch { seed = null }
  // A newer restart or a stop ran while this one waited, and it owns the
  // poll now — including when it turned capture off.
  if (run !== generation || !cfg.enabled) return
  lastHash = seed
  timer = setInterval(() => { sample().catch(() => {}) }, Math.max(500, cfg.pollMs))
}

// Resuming is treated like starting: whatever is on the clipboard then, copied
// during the pause or not, is seeded rather than captured, and nothing is read
// while paused (TESTING.md G-CB1).
eventBus.on('recording', (recording: boolean) => { if (recording && cfg.enabled) void restart() })
