// credential_use producer (docs/DESIGN-core-and-capture.md §4d).
//
// "Which credentials did I use, where" is one of the questions an after-action
// review asks most, and the `credential_use` lane had no built-in producer —
// it only ever filled if an external agent posted to it, so by default it was
// always empty. This derives credential use from capture that already runs:
// a `-p` / `--password` on a command line, `user:pass@host` in a URL, an
// `Authorization` header, or a secret copied to the clipboard.
//
// ── What it records, and what it must never record ──────────────────────────
//
// It records the FACT of a credential being used and WHERE — the destination
// host, the scheme, the username when visible. It does NOT record the secret.
// The value is masked to its length before it leaves this module, because a
// credential_use event that carried the password in plaintext would put the
// very thing the operator is trying to be careful about into the chain, and
// the chain is the one place bytes are not supposed to live. This is the same
// line redaction-design.md draws: the fact is evidence, the secret is
// liability.
//
// Pure and side-effect-free: the caller (api-server, on the same command and
// header scan that already feeds loot detection) decides when to emit. That
// keeps the detection unit-testable without a capture pipeline, which matters
// because the risk here is a false negative that silently drops a real
// credential use, or a false positive that cries wolf on a flag that was not a
// password.

export type CredentialKind =
  | 'password_flag'   // -p / --password on a command line
  | 'url_userinfo'    // scheme://user:pass@host
  | 'auth_header'     // Authorization: Basic/Bearer/...
  | 'clipboard_secret'// a secret-shaped value copied to the clipboard

export interface CredentialUse {
  kind: CredentialKind
  /** The secret, masked to a length hint — never the value itself. */
  masked: string
  /** Auth scheme for auth_header (Basic, Bearer, …). */
  scheme?: string
  /** Where the credential was used, when derivable from the same text. */
  destHost?: string
  /** The username / principal, when visible alongside the secret. */
  userContext?: string
}

/** Replace a secret with a length-preserving mask, keeping at most a 1-char
 *  hint at each end for very long values so two different secrets do not look
 *  identical in the record — but never enough to reconstruct one. A short
 *  secret is fully masked. */
function mask(secret: string): string {
  const n = secret.length
  if (n === 0) return ''
  if (n <= 6) return '•'.repeat(n)
  return `${secret[0]}${'•'.repeat(n - 2)}${secret[n - 1]} (${n})`
}

// Long password/secret flags across the tools a red-teamer actually runs. Matched with a hard boundary after the flag
// name (`=` or whitespace) so `--pass` cannot match inside `--password` via
// alternation backtracking and walk off with the rest of the word as a value.
const LONG_FLAGS = ['password', 'passwd', 'pass', 'pw', 'secret', 'api-key', 'apikey', 'token']

/** Password/secret arguments on a command line:
 *   --password VALUE | --password=VALUE | -p VALUE | -pVALUE (mysql idiom).
 *
 *  Only lowercase `-p` is a short password flag: mysql uses `-p` for the
 *  password and `-P` for the port, and nmap's `-Pn` / `-p` are not passwords,
 *  so `-P` is deliberately excluded and a `-p` whose value is a port spec is
 *  skipped. */
function fromCommand(command: string): CredentialUse[] {
  const out: CredentialUse[] = []
  const val = `(?:"([^"]+)"|'([^']+)'|([^\\s]+))`

  const longAlt = LONG_FLAGS.join('|')
  const longRe = new RegExp(`(?:^|\\s)--(?:${longAlt})(?:=|\\s+)${val}`, 'g')
  let m: RegExpExecArray | null
  while ((m = longRe.exec(command)) !== null) {
    const value = m[1] ?? m[2] ?? m[3] ?? ''
    if (!value || value.startsWith('-')) continue
    out.push({ kind: 'password_flag', masked: mask(value) })
  }

  // Short `-p`: either `-p VALUE` (space) or `-pVALUE` (mysql, no space).
  const shortRe = new RegExp(`(?:^|\\s)-p(?:\\s+${val}|([^\\s-][^\\s]*))`, 'g')
  while ((m = shortRe.exec(command)) !== null) {
    const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
    if (!value || value.startsWith('-')) continue
    // `-p 445` / `-p 80,443` / `-p-` is an nmap port spec, not a password.
    if (/^[\d,\-]+$/.test(value)) continue
    out.push({ kind: 'password_flag', masked: mask(value) })
  }
  return out
}

/** `scheme://user:pass@host[:port]` anywhere in the text. */
function fromUrlUserinfo(text: string): CredentialUse[] {
  const out: CredentialUse[] = []
  const re = /([a-z][a-z0-9+.-]*):\/\/([^\s:@/]+):([^\s@/]+)@([^\s/:]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({
      kind: 'url_userinfo',
      masked: mask(m[3]),
      destHost: m[4],
      userContext: m[2]
    })
  }
  return out
}

/** `Authorization: Basic <b64>` / `Bearer <token>` / any scheme + token. For
 *  Basic, the base64 often decodes to `user:pass`; we surface the username but
 *  still mask the secret half. */
function fromAuthHeader(text: string, destHost?: string): CredentialUse[] {
  const out: CredentialUse[] = []
  const re = /(?:Authorization|Proxy-Authorization)\s*:\s*([A-Za-z]+)\s+([^\s]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const scheme = m[1]
    const token = m[2]
    let userContext: string | undefined
    if (/^basic$/i.test(scheme)) {
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8')
        const i = decoded.indexOf(':')
        if (i > 0 && /^[\x20-\x7e]+$/.test(decoded)) userContext = decoded.slice(0, i)
      } catch { /* not valid base64 — leave userContext undefined */ }
    }
    out.push({ kind: 'auth_header', scheme, masked: mask(token), destHost, userContext })
  }
  return out
}

export interface DetectOptions {
  /** Destination host for auth headers, when the caller knows it (mitmproxy). */
  destHost?: string
  /** Restrict to the sources that make sense for the input. Defaults to all. */
  sources?: CredentialKind[]
}

/**
 * Scan one piece of captured text for credential use. `command`-shaped input
 * (a shell command) should be passed whole; header/body text from mitmproxy
 * can be passed too — the detectors are independent and additive.
 */
export function detectCredentialUse(text: string, opts: DetectOptions = {}): CredentialUse[] {
  if (!text) return []
  const want = opts.sources ? new Set(opts.sources) : null
  const out: CredentialUse[] = []
  if (!want || want.has('password_flag')) out.push(...fromCommand(text))
  if (!want || want.has('url_userinfo')) out.push(...fromUrlUserinfo(text))
  if (!want || want.has('auth_header')) out.push(...fromAuthHeader(text, opts.destHost))
  return out
}

/** A clipboard value that looks like a secret is credential material the
 *  operator is about to paste somewhere. Kept separate because the input is a
 *  whole clipboard payload, not a command, and the "is this a secret" test is
 *  the loot patterns' job — the caller passes the loot verdict in. */
export function credentialFromClipboard(content: string, isSecret: boolean): CredentialUse | null {
  if (!isSecret || !content) return null
  return { kind: 'clipboard_secret', masked: mask(content.trim()) }
}
