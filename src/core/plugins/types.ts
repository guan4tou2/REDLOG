// RedLog plugin system — shared types.
//
// A plugin is a directory with a `plugin.json` manifest plus optional asset
// files (hook scripts, code modules). Plugins live in two roots:
//   - bundled:  <resources>/plugins/<id>/   (ships with RedLog)
//   - user:     ~/.redlog/plugins/<id>/     (dropped in by the operator)
//
// Plugins contribute through a declarative `contributes` block. Contributions
// fall into two TRUST TIERS:
//   🟢 declarative / out-of-process — data the app reads (loot/redaction/target
//      patterns, event types) or capture scripts the *operator* runs that only
//      talk to RedLog's authenticated HTTP API. None of this runs third-party
//      code inside RedLog, so none of it can subvert the hash-chained log.
//   🔴 privileged / in-process — code RedLog itself executes (MCP tools,
//      exporters, monitors). This is gated: content-hash pinning + explicit
//      operator consent + capability scoping, and the code runs in an isolated
//      utility process, never in the main process with the DB handle.

/** The plugin API contract version this manifest targets. Bump on breaking changes. */
export const PLUGIN_API_VERSION = 1

export type Confidence = 'high' | 'medium' | 'low'

/** 🟢 A loot/secret regex contributed to the LootDetector. */
export interface LootPatternContribution {
  type: string
  /** JS RegExp source (global flag is applied by the detector) */
  pattern: string
  confidence?: Confidence
  /** optional inline flags, e.g. "i" or "gm" (g is always added) */
  flags?: string
  /** v0.9.0: human-readable identifier for this pattern within the
   *  plugin. Shows up on matched loot events as `pattern_name` for
   *  audit traceability — "this AWS key was flagged by recon-pack's
   *  `acme-token-v2` rule, not the built-in `aws_key`". If omitted,
   *  the loot event carries `pattern_name = "${type}#${index}"` — good
   *  enough for provenance, but a real name is friendlier in reports. */
  name?: string
  /** v0.9.0: one-line description of what the pattern is meant to
   *  detect. Not used at match time — surfaced in Settings ▸ Plugins
   *  and exportable to audit bundles. */
  description?: string
}

/** 🟢 Redaction rule additions (merged into the active allow/denylist). */
export interface RedactionContribution {
  denylist?: string[]
  allowlist?: string[]
}

/** 🟢 A command-pattern tagger: when the pattern matches a shell command, stamp
 *  the listed fields onto the event's data. Used for tagging (e.g. MITRE
 *  ATT&CK techniques) that shouldn't be hardcoded in the core since different
 *  engagements use different tools — write your own patterns per shop, or let
 *  the SIEM/backend (ELK, Splunk) do the tagging instead and disable this
 *  plugin. All patterns whose match succeeds contribute their fields; later
 *  matches don't overwrite fields already set by an earlier one. */
export interface CommandTagContribution {
  /** debug/dedup id — shown in Settings ▸ Plugins for individual disabling */
  name: string
  /** JS RegExp source matched against the full command string */
  match: string
  flags?: string
  /** Fields to stamp onto the shell event's data. Values are constant strings.
      Reserved: mitre_ttp, technique_tool, technique_category; anything else is
      a free-form field the operator can filter/export on. */
  stamp: Record<string, string>
}

/** 🟢 A target-extraction rule: for commands matching `cmd`, pull a host with `extract`. */
export interface TargetExtractorContribution {
  /** JS RegExp source matched against the command's first token(s) */
  cmd: string
  /** JS RegExp source with one capture group; group 1 (or full match) is the
   *  host. Optional when `strategy` is given. */
  extract?: string
  flags?: string
  /** A named built-in extraction strategy (E1) — the same mechanisms the
   *  built-in extractors use (e.g. 'lastIpOrDomain', 'urlFromFlag'). Lets a
   *  plugin express logic a single regex cannot. Ignored if `extract` is set. */
  strategy?: string
  /** Flag name for the flag-based strategies (e.g. '-u' for urlFromFlag). */
  param?: string
  /** v0.9.1: per-extractor identifier within the plugin. Stamped on
   *  matched shell events as `extractor_name` for audit traceability
   *  — "this target was flagged by `bugbounty-lexicon`'s `nuclei-plus`
   *  rule, not the built-in nuclei matcher". Defaults to
   *  `${cmd}#${index}` when omitted. */
  name?: string
  /** v0.9.1: one-line description of what commands this rule targets.
   *  Not used at match time; surfaced in Settings ▸ Plugins. */
  description?: string
}

/** 🟢 A declarative event-type: gives an agent_type a label, lane, colour and icon. */
export interface EventTypeContribution {
  agentType: string
  label: string
  /** timeline lane to group under (falls back to a generic lane if unknown) */
  lane?: string
  /** hex or css colour for the timeline marker */
  color?: string
  /** short emoji/glyph shown in lists */
  icon?: string
}

/** 🟢 A capture integration — mirrors hooks-manager's PluginManifest shape. */
export interface CaptureContribution {
  id: string
  name: string
  description: string
  agentType: string
  /** E3: the event subtypes this producer emits under `agentType`, e.g.
   *  `["packet_flow"]` for pcap or `["c2_checkin","c2_task"]` for a c2 tailer.
   *  Lets capture-health tell one `scanner` producer's feed from another's, so
   *  a plugin producer shows real active/idle state — without it a producer is
   *  listed but its feed can't be attributed. Optional. */
  emits?: string[]
  /** CLI commands that must exist for this to be "available" (any-of) */
  requires?: string[]
  /** manifest-relative path to the hook script */
  hookFile: string
  installMethod: 'claude-settings' | 'shell-source' | 'manual'
  installTarget?: string
  shellRcFile?: string
  claudeSettingsMatcher?: string
  /** for installMethod 'manual': ordered copy-paste setup steps */
  manualSteps?: Array<{ label: string; command?: string }>
}

/** 🔴 Capabilities a privileged plugin may request. Least-authority; granted explicitly. */
export type Capability =
  | 'read:events'        // query the timeline
  | 'write:events'       // append events (attributed to the plugin's operator)
  | 'read:findings'      // read loot/findings (deprecated alias of read:bookmarks)
  | 'read:bookmarks'     // read the operator's bookmarks
  | 'read:config'        // read engagement config (scope, redaction rules)
  | 'net:outbound'       // make outbound network requests (exfil risk — flagged)

export const ALL_CAPABILITIES: Capability[] = [
  'read:events', 'write:events', 'read:findings', 'read:bookmarks', 'read:config', 'net:outbound'
]

/** 🟢 A declarative mapper: how a producer's raw payload becomes envelope
 *  fields. See src/core/mappers.ts for the path syntax. */
export interface MapperContribution {
  id: string
  version: string
  agentType: string
  fields: Record<string, string | string[]>
  tsSource?: string
  keepExtra?: boolean
}

export interface PluginContributes {
  // 🟢 declarative
  /** raw → envelope field mappings (docs/DESIGN-plugin-kernel.md §2). */
  mappers?: MapperContribution[]
  lootPatterns?: LootPatternContribution[]
  redaction?: RedactionContribution
  commandTags?: CommandTagContribution[]
  targetExtractors?: TargetExtractorContribution[]
  eventTypes?: EventTypeContribution[]
  capture?: CaptureContribution[]
  // 🔴 privileged (code) — manifest-relative module paths
  mcpTools?: string
  exporters?: string
  monitors?: string
  /** v0.8.2: TailerAdapter contribution. Module must `export const adapter =
   *  { agentKind, transcriptGlob, ... }` matching TailerAdapter. v0.8.2
   *  restricts this to bundled plugins only — user-plugin tailers require
   *  isolation work landing in v0.8.3+. */
  tailers?: string
}

/** What role a plugin plays (docs/DESIGN-plugin-kernel.md §2). `pack` is a
 *  bundle of several roles — the bundled starter pack is one. The kernel uses
 *  it to decide which plugins are capture *sources* for the health card. */
export type PluginKind = 'producer' | 'mapper' | 'enrichment' | 'exporter' | 'pack'

/** How the kernel decides a producer plugin is alive. */
export interface PluginHealthProbe {
  /** Alive if an event with `source = <plugin id>` (or any of `emits`)
   *  landed within this many seconds. Default 300. */
  lastEventWithinSec?: number
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  /** PLUGIN_API_VERSION this plugin was written against */
  redlogApi: number
  /** Envelope schema version this plugin emits (docs/DESIGN-plugin-kernel.md
   *  §3). Defaults to the current ENVELOPE_SCHEMA_VERSION. */
  schemaVersion?: number
  kind?: PluginKind
  /** agent_types a producer plugin lands on the timeline. */
  emits?: string[]
  health?: PluginHealthProbe
  contributes: PluginContributes
  /** 🔴 capabilities the privileged code needs; ignored for purely declarative plugins */
  capabilities?: Capability[]
  /** optional detached signature (base64) over the content hash */
  signature?: string
  /** publisher key id that produced `signature` */
  publisher?: string
}

export type PluginTier = 'declarative' | 'privileged'

export type PluginStatus =
  | 'active'            // loaded and contributing
  | 'needs-consent'     // 🔴 code plugin awaiting trust grant
  | 'hash-changed'      // 🔴 previously trusted but code changed on disk → re-consent
  | 'disabled'          // operator turned it off
  | 'error'             // manifest invalid / failed to load

export interface LoadedPlugin {
  manifest: PluginManifest
  /** absolute path to the plugin directory */
  dir: string
  /** 'bundled' | 'user' */
  source: 'bundled' | 'user'
  tier: PluginTier
  status: PluginStatus
  /** sha256 over manifest + all contributed code files */
  contentHash: string
  /** populated when status === 'error' */
  error?: string
  /** §8-4: the manifest targets one API version ahead of this RedLog. Its
   *  declarative contributions still apply (unknown keys ignored); a code
   *  plugin one version ahead is refused (status 'error') instead. UI can badge
   *  it "built for a newer RedLog — reading known parts". */
  apiAhead?: boolean
}
