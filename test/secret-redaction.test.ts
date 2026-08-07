import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { redactSecrets, outputIfPathHiddenByCommand } from '../src/core/secret-redaction'

// v0.7.2 A: golden-fixture parity test between the TS redactor (used by
// agent-transcript-tailer) and the Python block in hooks/claude-code-hook.sh
// lines 191-202. Any regex drift trips CI here rather than in production —
// the two producers must return byte-identical output for the same input,
// or the two audit paths would silently disagree on what "redacted" means.
//
// Fixtures are hand-crafted to cover each pattern once + a mixed-content
// case (multi-secret in one string). If you add a new pattern, add a case
// here AND to the shell hook's Python — CI will fail otherwise.

const FIXTURES: Array<{ name: string; input: string }> = [
  { name: 'plain', input: 'nothing sensitive here' },
  { name: 'api-key-assign', input: 'export API_KEY=abcdef1234567890 rest of line' },
  { name: 'password-assign-colon', input: 'password: hunter2xxx more text' },
  { name: 'bearer', input: 'curl -H "Authorization: Bearer abc.def-ghi_jkl123" host' },
  { name: 'aws', input: 'creds: AKIAIOSFODNN7EXAMPLE something' },
  // Synthetic fixtures — pattern-matching but not a live-money prefix so
  // GitHub push protection lets them through. `sk_test_` is Stripe's
  // documented test-mode prefix. gitleaks:allow
  { name: 'openai-sk', input: 'sk-proj-NOT_A_REAL_KEY_ZZZZZZZZZZZZZZZZ' },
  { name: 'stripe-test', input: 'sk_test_NOT_A_REAL_KEY_ZZZZZZZZZZZZZZZ' },
  { name: 'jwt', input: 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
  { name: 'github-token', input: 'ghp_1234567890abcdefghij1234567890abcdef' },
  { name: 'gitlab-token', input: 'glpat-abcdefghij1234567890' },
  { name: 'private-key-pem',
    input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----' },
  { name: 'mixed',
    input: 'API_KEY=abc123def AWS AKIA1234567890ABCDEF and Bearer xyz.tok' }
]

// Extract the Python redactor block from the shell hook and run it in isolation.
// We call the same regex list the hook uses, on the same input, expect the
// same output. Requires python3 in PATH.
function runShellRedactor(input: string): string {
  const hookPath = path.resolve(__dirname, '..', 'hooks', 'claude-code-hook.sh')
  const hookLines = fs.readFileSync(hookPath, 'utf-8').split('\n')
  // Extract the exact `patterns = [...]` list from the hook so drift is
  // impossible to hide — if someone changes the shell regex without touching
  // the TS, this test still uses the shell's authoritative list. `[` appears
  // inside character classes, so index-based bracket matching is unreliable;
  // walk lines instead, tracking indentation of the `patterns = [` opener.
  const startLine = hookLines.findIndex((l) => l.trim().startsWith('patterns = ['))
  if (startLine === -1) {
    throw new Error('claude-code-hook.sh no longer contains a `patterns = [...]` block; update this test')
  }
  const openIndent = hookLines[startLine].length - hookLines[startLine].trimStart().length
  let endLine = -1
  for (let i = startLine + 1; i < hookLines.length; i++) {
    const line = hookLines[i]
    if (line.trimStart() === ']' && (line.length - line.trimStart().length) === openIndent) {
      endLine = i
      break
    }
  }
  if (endLine === -1) {
    throw new Error('claude-code-hook.sh: could not find closing `]` of patterns list')
  }
  // The block is nested inside `if redact and output:` in the shell hook,
  // so every line has `openIndent` leading spaces. Strip that prefix so the
  // extracted literal parses at column 0 in our python -c wrapper.
  const patternsLiteral = hookLines
    .slice(startLine, endLine + 1)
    .map((l) => (l.startsWith(' '.repeat(openIndent)) ? l.slice(openIndent) : l))
    .join('\n')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-'))
  const stdinFile = path.join(tmp, 'in.txt')
  fs.writeFileSync(stdinFile, input, 'utf-8')
  try {
    const script = `
import re, sys
${patternsLiteral}
data = open(${JSON.stringify(stdinFile)}).read()
for pat, repl in patterns:
    data = re.sub(pat, repl, data)
sys.stdout.write(data)
`
    return execFileSync('python3', ['-c', script], { encoding: 'utf-8' })
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

describe('redaction parity — TS vs shell hook Python', () => {
  for (const fx of FIXTURES) {
    it(`byte-identical output: ${fx.name}`, () => {
      const shellOut = runShellRedactor(fx.input)
      const tsOut = redactSecrets(fx.input)
      expect(tsOut).toBe(shellOut)
    })
  }

  it('idempotent — redacting twice gives the same result', () => {
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
