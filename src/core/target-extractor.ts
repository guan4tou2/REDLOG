const URL_RE = /https?:\/\/([^/:?\s]+)/
const IP_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)\b/
const DOMAIN_RE = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+)\b/

// The EXTRACTION MECHANISMS are generic, named strategies that live in core (a
// shared library); the TOOL KNOWLEDGE — which command targets which host — is
// declarative data that lives OUTSIDE core, in the bundled `builtin-tools` pack
// (E1 Option B, docs/DESIGN-E1-target-extractor-plugins.md). Core no longer
// carries any per-tool table at all: at startup `initPlugins()` registers the
// pack's rows through the same `registerTargetExtractors` path any plugin uses,
// so built-ins and third-party extractors are one uniform list. Disabling the
// pack removes the built-in rows; a plugin can override them (user source wins
// over bundled). The only host recognition left in core is the generic
// "command carries an explicit URL" fallback. target-extractor.test.ts loads
// the bundled pack in setup and is the behaviour guard.

/** A named extraction mechanism: given the full command, return a host or null.
 *  `param` carries a flag name for the flag-based strategies. */
type Strategy = (cmd: string, param?: string) => string | null

const flagVal = (cmd: string, flag: string): string | null =>
  cmd.match(new RegExp(`${flag}\\s+["']?([^\\s"']+)`))?.[1] ?? null

export const STRATEGIES: Record<string, Strategy> = {
  // ssh user@host — else a bare IP or domain in the args.
  sshHost: (a) => a.match(/@([^\s:]+)/)?.[1] ?? a.match(IP_RE)?.[1] ?? a.match(DOMAIN_RE)?.[1] ?? null,
  // scp / rsync user@host:path
  afterAt: (a) => a.match(/@([^\s:]+)/)?.[1] ?? null,
  // nmap / masscan / hydra … — the last IP/domain token, skipping flags.
  lastIpOrDomain: (a) => lastIPOrDomain(a),
  // rustscan -a <target>, else last IP/domain.
  rustscanTarget: (a) => a.match(/-a\s+([^\s]+)/)?.[1] ?? lastIPOrDomain(a),
  // curl / wget — a URL host, else IP, else domain.
  urlHost: (a) => extractUrlHost(a),
  // sqlmap -u / wpscan --url — a URL flag value parsed to its host.
  urlFromFlag: (a, param) => { const u = param ? flagVal(a, param) : null; return u ? hostFromUrl(u) : null },
  // nikto -h, evil-winrm -i, bloodhound -d — a flag value, used as-is.
  flagValue: (a, param) => (param ? flagVal(a, param) : null),
  // impacket @host, else last IP/domain.
  impacketHost: (a) => a.match(/@([^\s/:]+)/)?.[1] ?? lastIPOrDomain(a),
  // nc / ncat / socat — first IP, else first domain.
  firstIpOrDomain: (a) => a.match(IP_RE)?.[1] ?? a.match(DOMAIN_RE)?.[1] ?? null,
  // dig — first non-flag, non-@ domain token.
  digTarget: (a) => a.trim().split(/\s+/).find((t) => DOMAIN_RE.test(t) && !t.startsWith('-') && !t.startsWith('@')) ?? null,
  // ldapsearch -h or -H
  ldapHost: (a) => a.match(/-[hH]\s+([^\s]+)/)?.[1] ?? null,
  // metasploit: set RHOSTS <target>
  rhosts: (a) => a.match(/RHOSTS?\s+([^\s]+)/i)?.[1] ?? null,
  // proxychains [-q|-f cfg] <cmd …> — strip the proxychains flags, then last IP/domain.
  proxychainsTarget: (a) => lastIPOrDomain(a.replace(/^proxychains4?\s+(-q\s+|-f\s+\S+\s+)*/, '')),
  // sshuttle -r [user@]host
  sshuttleHost: (a) => a.match(/-r\s+(?:[^@\s]+@)?([^\s]+)/)?.[1] ?? null,
  // chisel client [scheme://]host
  chiselHost: (a) => a.match(/client\s+(?:https?:\/\/)?([^\s:/]+)/)?.[1] ?? null,
  // ligolo agent -connect host[:port]
  ligoloConnect: (a) => a.match(/-connect\s+([^\s:]+)/)?.[1] ?? null
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url.startsWith('http') ? url : `http://${url}`).hostname
  } catch {
    return url.match(URL_RE)?.[1] ?? null
  }
}

function extractUrlHost(args: string): string | null {
  const urlMatch = args.match(URL_RE)
  if (urlMatch) return urlMatch[1]
  return args.match(IP_RE)?.[1] ?? args.match(DOMAIN_RE)?.[1] ?? null
}

function lastIPOrDomain(args: string): string | null {
  const tokens = args.trim().split(/\s+/).filter(t => !t.startsWith('-'))
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (IP_RE.test(tokens[i])) return tokens[i].match(IP_RE)![1]
    if (DOMAIN_RE.test(tokens[i])) return tokens[i].match(DOMAIN_RE)![1]
  }
  return null
}

// Registered extractors (🟢 declarative) — both the bundled `builtin-tools`
// pack and any third-party plugin land here. Each is a cmd matcher plus either
// a named strategy or a single-capture-group regex whose group 1 (or full
// match) is the host.
interface ExternalExtractor {
  cmd: RegExp
  /** Either a regex (single capture group) or a named strategy — exactly one. */
  extract?: RegExp
  strategy?: string
  param?: string
  pluginId: string
  /** v0.9.1: per-extractor identifier — plugin-supplied `name` or the
   *  default `${cmd}#${index}` when omitted. */
  extractorName: string
  /** v0.9.1: optional human description (not used at match time). */
  description?: string
  /** E1 Option B: 'user' extractors override 'bundled' ones (the built-in
   *  pack), so an engagement can teach RedLog a tool the pack gets wrong.
   *  Matches the loader's same-id "user wins over bundled" rule. */
  source: 'bundled' | 'user'
}
const externalPatterns: ExternalExtractor[] = []

export function registerTargetExtractors(
  pluginId: string,
  extractors: Array<{
    cmd: string
    extract?: string
    flags?: string
    strategy?: string
    param?: string
    name?: string
    description?: string
  }>,
  source: 'bundled' | 'user' = 'user'
): number {
  let added = 0
  extractors.forEach((e, i) => {
    try {
      const extractorName = e.name && e.name.trim() ? e.name.trim() : `${e.cmd}#${i}`
      // A strategy plugin gets the same mechanism the built-ins use; otherwise
      // fall back to the single-capture-group regex. A row with neither is skipped.
      if (e.strategy && STRATEGIES[e.strategy]) {
        // `flags` applies to the cmd matcher for strategy rows (the strategy
        // owns its own value extraction) — e.g. the built-in RHOSTS row needs
        // a case-insensitive cmd match.
        externalPatterns.push({ cmd: new RegExp(e.cmd, e.flags), strategy: e.strategy, param: e.param, pluginId, extractorName, description: e.description, source })
        added++
      } else if (e.extract) {
        externalPatterns.push({ cmd: new RegExp(e.cmd), extract: new RegExp(e.extract, e.flags), pluginId, extractorName, description: e.description, source })
        added++
      }
    } catch { /* bad regex — skip */ }
  })
  return added
}

export function unregisterTargetExtractors(pluginId: string): void {
  for (let i = externalPatterns.length - 1; i >= 0; i--) {
    if (externalPatterns[i].pluginId === pluginId) externalPatterns.splice(i, 1)
  }
}

/** v0.9.1: introspect the currently-registered plugin extractors for
 *  Settings ▸ Plugins UI + audit bundle export. */
export function listExternalTargetExtractors(): Array<{
  pluginId: string
  extractorName: string
  cmd: string
  extract: string
  flags: string
  strategy?: string
  description?: string
}> {
  return externalPatterns.map((p) => ({
    pluginId: p.pluginId,
    extractorName: p.extractorName,
    cmd: p.cmd.source,
    extract: p.extract?.source ?? '',
    flags: p.extract?.flags ?? '',
    strategy: p.strategy,
    description: p.description
  }))
}

/** v0.9.1: extract with provenance. When a plugin extractor matches,
 *  returns `pluginId` + `extractorName` alongside the host so callers
 *  can stamp attribution onto shell events. Built-in matches return
 *  neither field — event shape stays byte-identical to pre-v0.9.1
 *  for built-in extraction (no chain-hash regression). */
export function extractTargetWithProvenance(command: string): {
  host: string | null
  pluginId?: string
  extractorName?: string
} {
  const trimmed = command.trim()
  // User-source (third-party plugin) extractors take precedence over the
  // bundled built-in pack — they let an engagement teach RedLog a tool the
  // pack gets wrong, or one it doesn't know. A user extractor only "wins" when
  // it actually yields a host (a non-match falls through, exactly as before).
  for (const p of externalPatterns) {
    if (p.source !== 'user') continue
    if (!p.cmd.test(trimmed)) continue
    if (p.strategy) {
      const host = STRATEGIES[p.strategy]?.(trimmed, p.param) ?? null
      if (host) return { host, pluginId: p.pluginId, extractorName: p.extractorName }
    } else if (p.extract) {
      const m = trimmed.match(p.extract)
      if (m) return { host: m[1] ?? m[0], pluginId: p.pluginId, extractorName: p.extractorName }
    }
  }
  // Bundled built-in pack: the FIRST row whose cmd matches wins, and its
  // result is returned even when the strategy yields null — a matched built-in
  // is authoritative for that command and short-circuits the URL fallback
  // below (byte-identical to the pre-Option-B in-core BUILTIN_ROWS loop). No
  // provenance fields — event shape stays identical for built-in matches.
  for (const p of externalPatterns) {
    if (p.source !== 'bundled') continue
    if (!p.cmd.test(trimmed)) continue
    if (p.strategy) return { host: STRATEGIES[p.strategy]?.(trimmed, p.param) ?? null }
    if (p.extract) { const m = trimmed.match(p.extract); return { host: m ? (m[1] ?? m[0]) : null } }
  }
  // Fallback: only when the command carries an explicit URL scheme (http:// or
  // https://). Was previously calling extractUrlHost() unconditionally, which
  // ran DOMAIN_RE across any shell string — so `python -c "import json.dumps"`
  // recorded a target of `json.dumps`, `source ~/.redlog/shell-preexec-hook.sh`
  // recorded `shell-preexec-hook.sh`, and `ls foo.txt` recorded `foo.txt`.
  // Requiring `://` cuts the false positives without losing real cases
  // (docker/curl/wget with a URL in the middle still get caught here).
  if (/https?:\/\//i.test(trimmed)) return { host: extractUrlHost(trimmed) }
  return { host: null }
}

/** Thin backward-compatible wrapper — returns just the host. Callers that
 *  don't want to record attribution (e.g. CDP target-id resolution) can
 *  keep using this shape unchanged. */
export function extractTarget(command: string): string | null {
  return extractTargetWithProvenance(command).host
}

