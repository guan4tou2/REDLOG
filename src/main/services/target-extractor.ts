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

export function extractTarget(command: string): string | null {
  const trimmed = command.trim()
  for (const pattern of PATTERNS) {
    if (pattern.cmd.test(trimmed)) {
      return pattern.extract(trimmed)
    }
  }
  return extractUrlHost(trimmed) ?? null
}

