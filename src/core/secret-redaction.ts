// Shared secret redactor for transcript and tool payloads.
//
// NAME NOTE: this file was originally created as `redaction.ts` but the
// project already had a `src/core/redaction.ts` with an unrelated
// `maskText` / `registerRedactionRules` API used by the four-layer
// sanitizer + plugin contributions. Renamed to avoid the collision; the
// two files serve different purposes (secret-pattern regex vs. span-mask
// sanitizer) and shouldn't share a namespace.
//
// Applied at ingest time by:
//   - src/main/services/tailer-host.ts (per user_message /
//     assistant_message / tool_input.command / tool_result.output before
//     insert into the events table).

// The shapes and the order they are applied in live in `secret-patterns.ts`,
// beside the loot detector's list, so the two can be compared in one place.

import { REDACT_IN_TRANSCRIPTS, TRANSCRIPT_PREFILTER, compileShape } from './secret-patterns'
const PATTERNS: Array<[RegExp, string]> =
  REDACT_IN_TRANSCRIPTS.map(({ shape, replacement }) => [compileShape(shape), replacement])

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

export function redactSecrets(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    return typeof input === 'string' ? input : String(input ?? '')
  }
  if (!TRANSCRIPT_PREFILTER.test(input)) return input
  let out = input
  for (const [pat, repl] of PATTERNS) out = out.replace(pat, repl)
  return out
}

const SENSITIVE_PATH_HINTS = [
  '.claude/', '.ssh/', '.env', '.netrc', 'credentials', '.aws/',
  '.npmrc', '.docker/config.json', '.kube/config', '.gnupg/', '.pgpass', '.pypirc'
]

export function outputIfPathHiddenByCommand(command: string, output: string): string {
  for (const hint of SENSITIVE_PATH_HINTS) {
    if (command.includes(hint)) return '[output hidden — sensitive path]'
  }
  return output
}
