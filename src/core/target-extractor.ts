const URL_RE = /https?:\/\/([^/:?\s]+)/
const IP_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)\b/
const DOMAIN_RE = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+)\b/

interface CommandPattern {
  cmd: RegExp
  extract: (args: string) => string | null
}

const PATTERNS: CommandPattern[] = [
  { cmd: /^ssh\s/, extract: (a) => a.match(/@([^\s:]+)/)?.[1] ?? a.match(IP_RE)?.[1] ?? a.match(DOMAIN_RE)?.[1] ?? null },
  { cmd: /^scp\s/, extract: (a) => a.match(/@([^\s:]+)/)?.[1] ?? null },
  { cmd: /^rsync\s/, extract: (a) => a.match(/@([^\s:]+)/)?.[1] ?? null },
  { cmd: /^nmap\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^masscan\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^rustscan\s/, extract: (a) => a.match(/-a\s+([^\s]+)/)?.[1] ?? lastIPOrDomain(a) },
  { cmd: /^curl\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^wget\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^httpie?\s|^http\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^sqlmap\s/, extract: (a) => { const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1]; return u ? hostFromUrl(u) : null } },
  { cmd: /^ffuf\s/, extract: (a) => { const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1]; return u ? hostFromUrl(u) : null } },
  { cmd: /^gobuster\s/, extract: (a) => { const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1]; return u ? hostFromUrl(u) : null } },
  { cmd: /^feroxbuster\s/, extract: (a) => { const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1]; return u ? hostFromUrl(u) : null } },
  { cmd: /^dirb\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^nikto\s/, extract: (a) => a.match(/-h\s+["']?([^\s"']+)/)?.[1] ?? null },
  { cmd: /^wpscan\s/, extract: (a) => { const u = a.match(/--url\s+["']?([^\s"']+)/)?.[1]; return u ? hostFromUrl(u) : null } },
  { cmd: /^nuclei\s/, extract: (a) => { const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1]; return u ? hostFromUrl(u) : null } },
  { cmd: /^hydra\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^crackmapexec\s|^cme\s|^netexec\s|^nxc\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^evil-winrm\s/, extract: (a) => a.match(/-i\s+([^\s]+)/)?.[1] ?? null },
  { cmd: /^impacket-|^python3?\s.*impacket/, extract: (a) => a.match(/@([^\s/:]+)/)?.[1] ?? lastIPOrDomain(a) },
  { cmd: /^nc\s|^ncat\s|^socat\s/, extract: (a) => a.match(IP_RE)?.[1] ?? a.match(DOMAIN_RE)?.[1] ?? null },
  { cmd: /^ping\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^traceroute\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^dig\s/, extract: (a) => { const parts = a.trim().split(/\s+/); return parts.find(p => DOMAIN_RE.test(p) && !p.startsWith('-') && !p.startsWith('@')) ?? null } },
  { cmd: /^ldapsearch\s/, extract: (a) => a.match(/-[hH]\s+([^\s]+)/)?.[1] ?? null },
  { cmd: /^bloodhound-python\s|^bloodhound\s/, extract: (a) => a.match(/-d\s+([^\s]+)/)?.[1] ?? null },
  { cmd: /^set\s+RHOSTS?\s/i, extract: (a) => a.match(/RHOSTS?\s+([^\s]+)/i)?.[1] ?? null },
  // Internal-network pivots — catalog the node reached through the pivot.
  { cmd: /^proxychains4?\s/, extract: (a) => lastIPOrDomain(a.replace(/^proxychains4?\s+(-q\s+|-f\s+\S+\s+)*/, '')) },
  { cmd: /^sshuttle\s/, extract: (a) => a.match(/-r\s+(?:[^@\s]+@)?([^\s]+)/)?.[1] ?? null },
  { cmd: /^chisel\s/, extract: (a) => a.match(/client\s+(?:https?:\/\/)?([^\s:/]+)/)?.[1] ?? null },
  { cmd: /ligolo|(^|\s)agent\s+.*-connect/, extract: (a) => a.match(/-connect\s+([^\s:]+)/)?.[1] ?? null },
]

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

// Plugin-contributed extractors (🟢 declarative). Each is a cmd matcher plus a
// single-capture-group regex whose group 1 (or full match) is the host.
interface ExternalExtractor {
  cmd: RegExp
  extract: RegExp
  pluginId: string
  /** v0.9.1: per-extractor identifier — plugin-supplied `name` or the
   *  default `${cmd}#${index}` when omitted. */
  extractorName: string
  /** v0.9.1: optional human description (not used at match time). */
  description?: string
}
const externalPatterns: ExternalExtractor[] = []

export function registerTargetExtractors(
  pluginId: string,
  extractors: Array<{
    cmd: string
    extract: string
    flags?: string
    name?: string
    description?: string
  }>
): number {
  let added = 0
  extractors.forEach((e, i) => {
    try {
      const extractorName = e.name && e.name.trim() ? e.name.trim() : `${e.cmd}#${i}`
      externalPatterns.push({
        cmd: new RegExp(e.cmd),
        extract: new RegExp(e.extract, e.flags),
        pluginId,
        extractorName,
        description: e.description
      })
      added++
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
  description?: string
}> {
  return externalPatterns.map((p) => ({
    pluginId: p.pluginId,
    extractorName: p.extractorName,
    cmd: p.cmd.source,
    extract: p.extract.source,
    flags: p.extract.flags,
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
  // Plugin extractors take precedence — they let an engagement teach RedLog
  // about bespoke tooling the built-in list doesn't know.
  for (const p of externalPatterns) {
    if (p.cmd.test(trimmed)) {
      const m = trimmed.match(p.extract)
      if (m) return { host: m[1] ?? m[0], pluginId: p.pluginId, extractorName: p.extractorName }
    }
  }
  for (const pattern of PATTERNS) {
    if (pattern.cmd.test(trimmed)) {
      return { host: pattern.extract(trimmed) }
    }
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

