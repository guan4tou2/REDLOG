// v0.7.2 A: shared secret redactor. Ported byte-for-byte from the Python
// block in hooks/claude-code-hook.sh lines 191-202 so the two producers
// stay in lock-step. `test/secret-redaction.test.ts` runs the SAME golden
// input through the shell hook and this TS port and asserts identical
// output — any regex drift trips CI, not production.
//
// NAME NOTE: this file was originally created as `redaction.ts` but the
// project already had a `src/core/redaction.ts` with an unrelated
// `maskText` / `registerRedactionRules` API used by the four-layer
// sanitizer + plugin contributions. Renamed to avoid the collision; the
// two files serve different purposes (secret-pattern regex vs. span-mask
// sanitizer) and shouldn't share a namespace.
//
// Applied at ingest time by:
//   - src/main/services/agent-transcript-tailer.ts (per user_message /
//     assistant_message / tool_input.command / tool_result.output before
//     insert into the events table).
//   - hooks/claude-code-hook.sh keeps its inline Python copy — the hook
//     runs from a shell, not the Electron main process, so we can't share
//     the TS at runtime; parity is enforced at CI time instead.

const PATTERNS: Array<[RegExp, string]> = [
  [
    /(?<name>api[_-]?key|api[_-]?secret|token|password|passwd|secret|authorization)[=: ]+\S+/gi,
    '$<name>=[REDACTED]'
  ],
  [/bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer [REDACTED]'],
  [/AKIA[0-9A-Z]{16}/g, '[AWS_KEY_REDACTED]'],
  [/(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}/gi, '[API_KEY_REDACTED]'],
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT_REDACTED]'],
  [/ghp_[A-Za-z0-9]{36}/g, '[GITHUB_TOKEN_REDACTED]'],
  [/glpat-[A-Za-z0-9_-]{20}/g, '[GITLAB_TOKEN_REDACTED]']
]

// v0.12.2: cheap prefilter. redactSecrets ran 8 regex replace() calls on
// every string, including agent turn bodies that are ~always plain prose.
// Union all pattern-triggering substrings into one anchored regex; if that
// misses, none of the 8 patterns can match either. Any character run that
// doesn't contain at least one of these keyword/prefix markers is safe:
//   - key/value keywords — the `(?<name>…)` group of PATTERNS[0]
//     (api_key/api-key/apisecret/api_secret/token/password/passwd/secret/authorization)
//   - `bearer` — for `Bearer <token>`
//   - `AKIA` — AWS access key literal prefix
//   - `sk-` / `sk_` — OpenAI/Stripe API key prefix
//   - `BEGIN` — PEM private key envelope
//   - `eyJ` — base64url `{"...` — every JWT's leading three bytes
//   - `ghp_` / `glpat` — GitHub / GitLab PAT prefix
// The union is one linear scan; 90%+ of tool_result bodies exit here.
// (v0.12.2 originally included `[=: ]` in the union, but a literal space
// matched every prose sentence and defeated the short-circuit; the fix is
// to prefilter on the identifying keyword itself, not the separator.)
const PREFILTER_RE = /api[_-]?key|api[_-]?secret|token|password|passwd|secret|authorization|bearer|AKIA|sk[-_]|BEGIN|eyJ|ghp_|glpat/i

export function redactSecrets(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    return typeof input === 'string' ? input : String(input ?? '')
  }
  if (!PREFILTER_RE.test(input)) return input
  let out = input
  for (const [pat, repl] of PATTERNS) out = out.replace(pat, repl)
  return out
}

const SENSITIVE_PATH_HINTS = ['.claude/', '.ssh/', '.env', '.netrc', 'credentials', '.aws/']

export function outputIfPathHiddenByCommand(command: string, output: string): string {
  for (const hint of SENSITIVE_PATH_HINTS) {
    if (command.includes(hint)) return '[output hidden — sensitive path]'
  }
  return output
}
