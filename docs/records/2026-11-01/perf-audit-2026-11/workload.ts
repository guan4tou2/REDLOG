// A synthetic engagement: the event mix a pentest session actually produces,
// shaped like the real producers' payloads (hooks/redlog-hook.*,
// hooks/mitmproxy-addon.py, the Claude Code hook, the DNS lane).
//
// One "cycle" is one operator command and what follows it:
//   shell   command_start + command_end (≈1.5 KB stdout)            2 rows
//   http    3 flows × (http_request_start + http_response 6 KB)     6 rows
//   agent   pre/post tool use                                       2 rows
//   dns     1 query                                                 1 row
// = 11 rows. Every 50th cycle adds a marker. Payload sizes are deliberately
// ordinary, not worst case; the audit is about where ordinary time goes.

export interface WorkEvent {
  agentType: string
  data: Record<string, unknown>
  targetId?: string
}

const HOSTS = ['10.10.11.5', '10.10.11.23', 'dc01.corp.local', 'web.corp.local', '192.168.56.101', 'app.example.com']
const TOOLS = [
  (h: string) => `nmap -sV -p- ${h}`,
  (h: string) => `curl -sk https://${h}/login`,
  (h: string) => `ffuf -w /usr/share/wordlists/dirb/common.txt -u http://${h}/FUZZ`,
  (h: string) => `crackmapexec smb ${h} -u users.txt -p Passw0rd!`,
  (h: string) => `ssh -i id_rsa admin@${h} 'id; uname -a'`,
  (h: string) => `gobuster dns -d ${h} -w subdomains.txt`,
  (h: string) => `sqlmap -u "http://${h}/item.php?id=1" --batch`,
  () => 'ls -la /tmp'
]

function lorem(n: number, seed: number): string {
  const words = ['open', 'tcp', 'http', 'Apache', 'httpd', '2.4.41', 'ssh', 'OpenSSH', '8.2p1', 'Ubuntu', 'filtered', 'closed',
    'Service', 'detection', 'performed', 'PORT', 'STATE', 'VERSION', '/admin', '/login', 'Status:', '200', '301', '403', 'Size:']
  let s = ''
  let i = seed
  while (s.length < n) { s += words[i % words.length] + (i % 9 === 0 ? '\n' : ' '); i = (i * 1103515245 + 12345) >>> 0 }
  return s.slice(0, n)
}

const HEADERS_REQ: [string, string][] = [
  ['Host', ''], ['User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'],
  ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'], ['Accept-Language', 'en-US,en;q=0.9'],
  ['Accept-Encoding', 'gzip, deflate, br'], ['Connection', 'keep-alive'], ['Upgrade-Insecure-Requests', '1'],
  ['Sec-Fetch-Dest', 'document'], ['Sec-Fetch-Mode', 'navigate'], ['Sec-Fetch-Site', 'none'], ['Cookie', 'theme=dark; lang=en']
]
const HEADERS_RESP: [string, string][] = [
  ['Server', 'nginx/1.18.0 (Ubuntu)'], ['Date', 'Sat, 01 Nov 2026 10:00:00 GMT'], ['Content-Type', 'text/html; charset=UTF-8'],
  ['Transfer-Encoding', 'chunked'], ['Connection', 'keep-alive'], ['Cache-Control', 'no-store, no-cache, must-revalidate'],
  ['X-Frame-Options', 'SAMEORIGIN'], ['Set-Cookie', 'PHPSESSID=8f2b1c; path=/; HttpOnly']
]

/** The events of cycle `i`. `now` is only used for source timestamps. */
export function cycle(i: number, opts: { terminalId?: string; now?: number } = {}): WorkEvent[] {
  const host = HOSTS[i % HOSTS.length]
  const command = TOOLS[i % TOOLS.length](host) + ` # run ${i}`
  const terminalId = opts.terminalId ?? 'term-bench'
  const pid = 40000 + (i % 5000)
  const out: WorkEvent[] = []
  const commandId = `cmd-${i}`
  out.push({ agentType: 'shell', data: {
    subtype: 'command_start', command, command_id: commandId, cwd: '/home/kali/engagement', terminal_id: terminalId,
    pid, shell: 'zsh', user: 'kali', source: 'hook'
  } })
  out.push({ agentType: 'shell', data: {
    subtype: 'command_end', command, command_id: commandId, cwd: '/home/kali/engagement', terminal_id: terminalId,
    pid, shell: 'zsh', user: 'kali', source: 'hook', exit_code: i % 7 === 0 ? 1 : 0, duration_sec: 1 + (i % 30),
    stdout: lorem(1500, i), stderr: i % 5 === 0 ? lorem(200, i + 1) : ''
  } })
  for (let f = 0; f < 3; f++) {
    const flowId = `flow-${i}-${f}`
    const url = `https://${host}/app/${['login', 'api/users', 'static/app.js'][f]}?q=${i}`
    out.push({ agentType: 'scanner', data: {
      subtype: 'http_request_start', flow_id: flowId, method: f === 0 ? 'POST' : 'GET', url, path: url.slice(url.indexOf('/', 8)),
      host, port: 443, scheme: 'https', request_headers: HEADERS_REQ.map(([k, v]) => [k, k === 'Host' ? host : v]),
      // A login form with a password-shaped field, so redaction has something to
      // match. No username key: nothing in ingest reads one, and the pair reads as
      // a credential to secret scanners. Same 31 bytes as before, so §3 holds.
      ...(f === 0 ? { request_body_preview: 'remember_me=on&password=hunter2', request_body: { data: 'remember_me=on&password=hunter2', encoding: 'text', size: 31 } } : {}),
      http_version: 'HTTP/1.1', source_addr: `127.0.0.1:${50000 + (i % 10000)}`, pid
    } })
    const body = lorem(6000, i * 3 + f)
    out.push({ agentType: 'scanner', data: {
      subtype: 'http_response', flow_id: flowId, method: f === 0 ? 'POST' : 'GET', url, status: [200, 302, 200][f],
      content_length: body.length, content_type: 'text/html; charset=UTF-8', response_headers: HEADERS_RESP,
      response_preview: body.slice(0, 1024), response_body: { data: body, encoding: 'text', size: body.length }, duration_ms: 40 + (i % 200)
    } })
  }
  out.push({ agentType: 'agent', data: {
    subtype: 'pre_tool_use', session_id: `claude-${Math.floor(i / 200)}`, tool_name: 'Bash', tool_use_id: `tu-${i}`,
    tool_input: { command: `cat notes/${host}.md`, description: 'read notes' }, source: 'claude-code', transcript_uuid: `tr-${i}`
  } })
  out.push({ agentType: 'agent', data: {
    subtype: 'post_tool_use', session_id: `claude-${Math.floor(i / 200)}`, tool_name: 'Bash', tool_use_id: `tu-${i}`,
    tool_response: { stdout: lorem(800, i + 7), stderr: '', interrupted: false }, source: 'claude-code', transcript_uuid: `tr-${i}-r`
  } })
  out.push({ agentType: 'dns', data: { subtype: 'query', qname: `${['www', 'api', 'mail', 'vpn'][i % 4]}.${host}`, qtype: 'A', answers: ['10.10.11.5'] } })
  if (i % 50 === 0) {
    out.push({ agentType: 'marker', data: { subtype: 'marker', title: `Finding ${i}: weak creds on ${host}`, severity: 'high', note: lorem(300, i) } })
  }
  return out
}
