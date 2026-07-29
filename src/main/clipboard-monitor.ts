import { clipboard } from 'electron'
import { createHash } from 'crypto'
import { insertEvent } from '../core/db/events'
import { eventBus } from '../core/event-bus'
import { redact, getRules } from '../core/redaction'
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

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function sample(): void {
  let text: string
  try { text = clipboard.readText() } catch { return }
  if (!text) return
  const hash = sha256(text)
  if (hash === lastHash) return
  lastHash = hash
  // Redact the preview before it hits the DB. Even if loot patterns miss
  // something, the operator's own redaction rules (allowlist/denylist/entropy)
  // strip secrets. Full text is never stored — only a short preview at most.
  const rules = getRules()
  const previewRaw = text.slice(0, 120)
  const redacted = redact(previewRaw, rules)
  const preview = cfg.storePreview ? redacted.text : null
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
    const ev = insertEvent('clipboard', {
      subtype: 'clipboard_changed',
      sha256: hash,
      length: text.length,
      lines: text.split('\n').length,
      lootTypes: lootTypes.length > 0 ? lootTypes : undefined,
      preview,  // null when storePreview is off
      redactionsInPreview: redacted.redacted.length > 0 ? redacted.redacted.length : undefined
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch { /* DB may not be ready during startup */ }
}

export function configureClipboardMonitor(next: Partial<Config>): void {
  cfg = { ...cfg, ...next }
  restart()
}

export function startClipboardMonitor(): void { restart() }

export function stopClipboardMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
  lastHash = null
}

function restart(): void {
  if (timer) { clearInterval(timer); timer = null }
  if (!cfg.enabled) return
  // Seed lastHash so the first poll doesn't emit an event for whatever was on
  // the clipboard before RedLog opened — that's out-of-scope for this session.
  try { lastHash = sha256(clipboard.readText() || '') } catch { lastHash = null }
  timer = setInterval(sample, Math.max(500, cfg.pollMs))
}
