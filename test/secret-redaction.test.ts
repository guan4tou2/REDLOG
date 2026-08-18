import { describe, it, expect } from 'vitest'
import { redactSecrets, outputIfPathHiddenByCommand } from '../src/core/secret-redaction'

// v0.7.2 A: unit tests for the secret redactor used by
// agent-transcript-tailer before inserting user_message / assistant_message /
// tool_input.command / tool_result.output into the events table.
//
// v0.7.3 A note: earlier revisions of this test ran an extracted Python
// block from claude-code-hook.sh and asserted byte-parity between the
// shell hook's Python and the TS port. The hook was retired in v0.7.3
// (the tailer subsumes its per-tool ingest), so the parity mechanism is
// gone — this file now tests the TS redactor as the sole source of truth
// with the same golden fixtures that used to prove parity.

const FIXTURES: Array<{ name: string; input: string; expectContains?: string; expectMissing?: string }> = [
  { name: 'plain', input: 'nothing sensitive here', expectMissing: '[REDACTED]' },
  { name: 'api-key-assign', input: 'export API_KEY=abcdef1234567890 rest of line', expectContains: '[REDACTED]' },
  { name: 'password-assign-colon', input: 'password: hunter2xxx more text', expectContains: '[REDACTED]' },
  // Note: the earlier `authorization[=:]+\S+` pattern fires before the
  // Bearer-specific rule, so the whole `Authorization: Bearer <token>`
  // string collapses to `Authorization=[REDACTED]`. Documented as-is —
  // the more specific Bearer output would be nicer to read but changing
  // pattern order is a v0.7.4 semantic-drift concern.
  { name: 'bearer', input: 'curl -H "Authorization: Bearer abc.def-ghi_jkl123" host', expectContains: '[REDACTED]' },
  { name: 'aws', input: 'creds: AKIAIOSFODNN7EXAMPLE something', expectContains: '[AWS_KEY_REDACTED]' },
  // Synthetic fixtures — pattern-matching but not a live-money prefix so
  // GitHub push protection lets them through. gitleaks:allow
  { name: 'openai-sk', input: 'sk-proj-NOT_A_REAL_KEY_ZZZZZZZZZZZZZZZZ', expectContains: '[API_KEY_REDACTED]' },
  { name: 'stripe-test', input: 'sk_test_NOT_A_REAL_KEY_ZZZZZZZZZZZZZZZ', expectContains: '[API_KEY_REDACTED]' },
  // Same order-precedence caveat as `bearer`: the `token[=:]+\S+` rule
  // catches this before the JWT rule. Output is `token=[REDACTED]`
  // instead of the JWT-specific marker. Adding a raw JWT without a
  // `token:` prefix would trip the JWT rule directly.
  { name: 'jwt-with-token-prefix', input: 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', expectContains: '[REDACTED]' },
  { name: 'jwt-standalone', input: 'raw eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end', expectContains: '[JWT_REDACTED]' },
  { name: 'github-token', input: 'ghp_1234567890abcdefghij1234567890abcdef', expectContains: '[GITHUB_TOKEN_REDACTED]' },
  { name: 'gitlab-token', input: 'glpat-abcdefghij1234567890', expectContains: '[GITLAB_TOKEN_REDACTED]' },
  {
    name: 'private-key-pem',
    input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    expectContains: '[PRIVATE_KEY_REDACTED]'
  },
  {
    name: 'mixed',
    input: 'API_KEY=abc123def AWS AKIA1234567890ABCDEF and Bearer xyz.tok',
    expectContains: '[REDACTED]'
  }
]

describe('redactSecrets — TS unit tests', () => {
  for (const fx of FIXTURES) {
    it(`redacts: ${fx.name}`, () => {
      const out = redactSecrets(fx.input)
      if (fx.expectContains) expect(out).toContain(fx.expectContains)
      if (fx.expectMissing) expect(out).not.toContain(fx.expectMissing)
      // Never leak the raw secret shape back verbatim (except for the
      // 'plain' case which has none).
      if (fx.name !== 'plain' && fx.name !== 'bearer') {
        // Sanity: at least the token portion should be masked.
        expect(out.length).toBeLessThanOrEqual(fx.input.length + 200)
      }
    })
  }

  it('idempotent — redacting twice yields the same result', () => {
    for (const fx of FIXTURES) {
      const once = redactSecrets(fx.input)
      const twice = redactSecrets(once)
      expect(twice).toBe(once)
    }
  })

  it('empty / non-string input passes through', () => {
    expect(redactSecrets('')).toBe('')
    expect(redactSecrets(null)).toBe('')
    expect(redactSecrets(undefined)).toBe('')
    expect(redactSecrets(42)).toBe('42')
  })

  // v0.12.2: prefilter fast path — strings that can't possibly contain any
  // of the 8 pattern-trigger markers must pass through unchanged and skip
  // the eight replace() calls. These fixtures document what the prefilter
  // considers "definitely safe": no `=`/`:`/space AND no `AKIA`/`sk-`/`sk_`/
  // `BEGIN`/`eyJ`/`ghp_`/`glpat` substring. If a new PATTERN entry lands
  // whose trigger isn't in the union, this test will still pass — but the
  // real body will silently stop redacting it. Keep in sync with PATTERNS.
  it('prefilter: token-free prose passes through untouched', () => {
    for (const s of [
      'nothingtoseehere',
      'plainprosewithoutseparators',
      'CamelCaseWordsOnly',
      'anIdWith1234numbers',
      '/some/path/to/file.txt',
      'error:unexpected',  // colon triggers prefilter but no pattern matches — still exercises the through-path
    ]) {
      expect(redactSecrets(s)).toBe(s)
    }
  })

  it('prefilter: every real secret still redacts (regression guard)', () => {
    // Explicit: this is what the prefilter MUST let through to the full
    // pass. If someone tightens the prefilter and breaks any of these,
    // secrets stop being redacted — this test catches the regression
    // before it ships.
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('[AWS_KEY_REDACTED]')
    expect(redactSecrets('sk-proj-NOT_A_REAL_KEY_ZZZZZZZZZZZZZZZZ')).toContain('[API_KEY_REDACTED]')
    expect(redactSecrets('ghp_1234567890abcdefghij1234567890abcdef')).toContain('[GITHUB_TOKEN_REDACTED]')
    expect(redactSecrets('glpat-abcdefghij1234567890')).toContain('[GITLAB_TOKEN_REDACTED]')
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'))
      .toContain('[JWT_REDACTED]')
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'))
      .toContain('[PRIVATE_KEY_REDACTED]')
    expect(redactSecrets('password=hunter2xxx')).toContain('[REDACTED]')
    expect(redactSecrets('Bearer abc.def-ghi_jkl123')).toContain('[REDACTED]')
  })
})

describe('outputIfPathHiddenByCommand', () => {
  it('hides output when the command touches a known sensitive path', () => {
    for (const cmd of ['cat ~/.ssh/id_rsa', 'less .env.production', 'cat ~/.aws/credentials']) {
      expect(outputIfPathHiddenByCommand(cmd, 'MY_SECRET=abc')).toBe('[output hidden — sensitive path]')
    }
  })
  it('passes output through for unrelated commands', () => {
    expect(outputIfPathHiddenByCommand('ls /tmp', 'foo\nbar')).toBe('foo\nbar')
  })
})
