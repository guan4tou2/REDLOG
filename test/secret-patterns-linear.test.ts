// Every built-in secret shape runs in time linear in its input, and the
// rewrites that made it so changed no match.
//
// The shapes run on the main thread over captured command output of up to
// 8 MiB. Before the rewrite, two JWT shapes, the URI-credentials shape and the
// PEM block shape restarted a scan of a whole run from every place a match
// could begin inside it: 128 KiB of `eyJeyJ…` took 5.2 s, 16 KiB of plain
// lowercase letters took about a second in the URI shape. Separately, every
// `X{n,}` shape threw "Maximum call stack size exceeded" on a multi-MiB match,
// which threw out of ingest and lost the event.
//
// `OLD` below is the table as it was, kept as the reference. The equivalence
// tests run old and new over a realistic corpus and a seeded random corpus and
// require the same matches (index, text, groups), the same redacted text and
// the same loot. Credential-shaped inputs are assembled at run time — see the
// note in secret-patterns-golden.test.ts.

import { describe, expect, it } from 'vitest'
import {
  SECRET_SHAPES, REDACT_IN_TRANSCRIPTS, DETECT_AS_LOOT, TRANSCRIPT_PREFILTER, compileShape,
  type SecretShapeId
} from '../src/core/secret-patterns'
import { redactSecrets } from '../src/core/secret-redaction'
import { LootDetector } from '../src/core/loot-detector'

const R = String.raw
const J = 'ey' + 'J'
// The table before the linear rewrite, source and flags verbatim.
const OLD: Record<SecretShapeId, [string, string]> = {
  named_secret_assignment: [R`(?<name>api[_-]?key|api[_-]?secret|token|password|passwd|secret|authorization)[=: ]+\S+`, 'gi'],
  bearer_token: [R`bearer\s+[A-Za-z0-9_\-.]+`, 'gi'],
  aws_access_key: [R`AK` + R`IA[0-9A-Z]{16}`, 'g'],
  prefixed_api_key: [R`(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}`, 'gi'],
  private_key_block: [R`-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----`, 'g'],
  jwt_three_segment: [J + R`[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`, 'g'],
  github_pat: [R`gh` + R`p_[A-Za-z0-9]{36}`, 'g'],
  gitlab_pat: [R`gl` + R`pat-[A-Za-z0-9_-]{20}`, 'g'],
  slack_token: [R`xo` + R`x[bpsa]-[A-Za-z0-9-]{10,}`, 'g'],
  npm_token: [R`np` + R`m_[A-Za-z0-9]{36,}`, 'g'],
  huggingface_token: [R`h` + R`f_[A-Za-z0-9]{20,}`, 'g'],
  google_oauth_client_secret: [R`GOC` + R`SPX-[A-Za-z0-9_-]+`, 'g'],
  uri_userinfo_credentials: [R`[a-z+]+:\/\/[^/:@\s]+:[^/@\s]+@[^\s]+`, 'gi'],
  der_base64_key: [R`MII[A-Za-z0-9+/]{100,}={0,2}`, 'g'],
  crypt_password_hash: [R`\$[126][\$a-z]*\$[./A-Za-z0-9]+`, 'g'],
  ntlm_hash_pair: [R`[a-fA-F0-9]{32}:[a-fA-F0-9]{32}`, 'g'],
  private_key_header: [R`-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]{16,})?`, 'g'],
  jwt_with_json_payload: [J + R`[A-Za-z0-9_-]+\.` + J + R`[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, 'g'],
  named_secret_value: [R`(?:api[_-]?key|apikey|token|secret|password)\s*[=:]\s*['"]?([^\s'"]{8,})`, 'gi'],
  database_url: [R`(?:mysql|postgres|mongodb|redis):\/\/[^\s]+`, 'gi'],
  shadow_entry: [R`^[a-z_][a-z0-9_-]*:\$[^:]+:[^:]*:[^:]*:[^:]*:[^:]*:`, 'gm'],
  basic_auth_header: [R`(?:Authorization|auth):\s*Basic\s+[A-Za-z0-9+/=]{10,}`, 'gi']
}
const IDS = Object.keys(SECRET_SHAPES) as SecretShapeId[]
const oldShape = (id: SecretShapeId): RegExp => new RegExp(OLD[id][0], OLD[id][1])

type Hit = [number, ...Array<string | undefined>]
function allMatches(re: RegExp, text: string): Hit[] {
  const r = new RegExp(re.source, re.flags)
  const out: Hit[] = []
  let m: RegExpExecArray | null
  while ((m = r.exec(text)) !== null) {
    out.push([m.index, ...m])
    if (m[0].length === 0) r.lastIndex++
  }
  return out
}

/** Transcript redaction as `redactSecrets` does it, with the old shapes. */
function oldRedact(text: string): string {
  if (!TRANSCRIPT_PREFILTER.test(text)) return text
  let out = text
  for (const { shape, replacement } of REDACT_IN_TRANSCRIPTS) out = out.replace(oldShape(shape), replacement)
  return out
}
/** Built-in loot as `findMatches` reports it, with the old shapes. */
function oldLoot(text: string): string[][] {
  const line = (i: number): string => {
    const end = text.indexOf('\n', i)
    return text.charCodeAt(i) === 0x0a ? '' : text.slice(text.lastIndexOf('\n', i - 1) + 1, end === -1 ? undefined : end).trim().slice(0, 200)
  }
  const out: string[][] = []
  for (const { shape, type, group } of DETECT_AS_LOOT) {
    for (const [index, ...m] of allMatches(oldShape(shape), text)) {
      const value = m[group]
      if (value) out.push([type, value.slice(0, 500), line(index)])
    }
  }
  return out
}
const newLoot = (text: string): string[][] => new LootDetector().findMatches(text).map((m) => [m.type, m.value, m.line])

function expectSameEverywhere(text: string): void {
  for (const id of IDS) {
    expect({ id, text, hits: allMatches(compileShape(id), text) }).toEqual({ id, text, hits: allMatches(oldShape(id), text) })
  }
  expect({ text, out: redactSecrets(text) }).toEqual({ text, out: oldRedact(text) })
  expect({ text, loot: newLoot(text) }).toEqual({ text, loot: oldLoot(text) })
}

// ─── Corpus ─────────────────────────────────────────────────────────────────

/** Deterministic PRNG, so a failure names a reproducible input. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = prng(0x5ec7e7)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const randFrom = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')
const b64u = (s: string): string => Buffer.from(s).toString('base64url')
const jwtPart = (o: object): string => b64u(JSON.stringify(o))
const HDR = jwtPart({ alg: 'HS256', typ: 'JWT' })
const PAY = jwtPart({ sub: '1234567890', name: 'Test User', iat: 1516239022 })
const BIG = jwtPart({ sub: 'u', roles: Array.from({ length: 120 }, (_, i) => `role-${i}`), data: 'x'.repeat(1500) })
const SIG = randFrom(B64 + '-_', 43)
const JWT3 = [HDR, PAY, SIG].join('.')
const pemBody = (lines: number): string => Array.from({ length: lines }, () => randFrom(B64 + '+/', 64)).join('\n')
const PK = (alg: string): [string, string] => [`-----BEGIN ${alg}PRIV` + `ATE KEY-----`, `-----END ${alg}PRIV` + `ATE KEY-----`]
const [H, F] = PK('')
const [HR, FR] = PK('RSA ')
const [HO, FO] = PK('OPENSSH ')
const KEY = `${H}\n${'MII' + pemBody(4).slice(3)}\n${F}`
const RSA = `${HR}\n${pemBody(5)}\n${FR}`
const CERT = `-----BEGIN CERTIFICATE-----\n${pemBody(3)}\n-----END CERTIFICATE-----`
const PW = randFrom(B64, 12)
const URI = (scheme: string, host = 'db.internal:5432/app'): string => `${scheme}://admin:${PW}@${host}`
const tok = (prefix: string, alphabet: string, n: number): string => prefix + randFrom(alphabet, n)
const P = ['pass', 'word'].join('')

const REALISTIC: string[] = [
  // JWTs where real tools put them
  `Authorization: Bearer ${JWT3}`,
  `curl -s -H 'Authorization: Bearer ${JWT3}' https://api.test/me`,
  `Cookie: session=${JWT3}; Path=/; HttpOnly`,
  `Set-Cookie: auth=${JWT3}; Secure`,
  `{"access_token":"${JWT3}","token_type":"Bearer","expires_in":3600}`,
  `{"id_token": "${HDR}.${BIG}.${SIG}"}`,
  `https://app.test/callback?code=abc&id_token=${JWT3}&state=xyz`,
  `https://app.test/#access_token=${JWT3}&expires_in=3600`,
  `export JWT=${JWT3}`,
  `JWT='${JWT3}' ./run.sh`,
  `token: ${JWT3}\nrefresh: ${HDR}.${PAY}.${randFrom(B64, 40)}`,
  `(${JWT3}), <${JWT3}>, "${JWT3}". [${JWT3}]`,
  `${JWT3}\n${JWT3}\n${JWT3}`,
  `${HDR}.${PAY}`, // two segments, unsigned
  `${HDR}.${PAY}.`, // alg=none: empty signature
  `${HDR}.${PAY}.${SIG}.${randFrom(B64, 22)}.${randFrom(B64, 22)}`, // JWE-like, five segments
  `x${JWT3}`, `_${JWT3}`, `${J}${JWT3}`, `${JWT3}${JWT3}`, `${HDR}${HDR}.${PAY}.${SIG}`,
  `${J}short.${J}x.y`, `${J}aaaaaaaaa.bbbbbbbbbb.cccccccccc`, `${J}aaaaaaaaaa.bbbbbbbbbb.cccccccccc`,
  `${J}${J}${J}.${J}${J}.${J}`,
  // URI credentials
  URI('postgres'), URI('mysql', 'db/app'), URI('https', 'host.test/path?q=1'), URI('git+ssh', 'git.test/r.git'),
  URI('HTTPS', 'HOST.TEST/'), `url=${URI('https')}`, `"${URI('redis', 'cache:6379')}"`, `(${URI('mongodb')})`,
  `xx${URI('http')}`, `9${URI('http')}`, `fetch ${URI('ftp', 'files.test')} done`,
  `redis://:${PW}@cache:6379`, 'https://host.test:8443/x', 'see https://host.test/a@b', 'mailto:user@host.test',
  // PEM blocks
  KEY, RSA, `${HO}\n${pemBody(6)}\n${FO}`, `${KEY}\n${RSA}`, `${KEY}${RSA}`, `${CERT}\n${KEY}`, `${KEY}\n${CERT}`,
  `head -3 key.pem\n${H}\n${pemBody(2)}\n$ cat key.pem\n${KEY}`, // truncated block, then the whole one
  `${H}\n${pemBody(2)}`, `${F}\n${H}`, `${H}\n${H}\n${F}`, KEY.replace(/\n/g, '\r\n'),
  `{"private_key":"${KEY.replace(/\n/g, '\\n')}"}`, `${F.slice(0, -5)}${H}\n${pemBody(1)}\n${F}`,
  `${H}\n${F.slice(0, -5)}${H}\n${pemBody(1)}\n${F}\n${H}\nZ\n${F}`,
  `${H}${F.slice(5)}\n${H}\nZ\n${F}`, `------BEGIN PRIV` + `ATE KEY-----\nx\n${F}`,
  // counted shapes at and around their minimum length
  ...[19, 20, 21, 64].flatMap((n) => [tok('sk-', B64 + '_-', n), tok('sk_live_', B64, n), tok('SK_TEST_', B64, n)]),
  ...[9, 10, 11, 40].map((n) => tok('xo' + 'xb-', B64 + '-', n)),
  ...[35, 36, 37, 50].map((n) => tok('np' + 'm_', B64, n)),
  ...[19, 20, 21, 34].map((n) => tok('h' + 'f_', B64, n)),
  ...[99, 100, 101, 1200].flatMap((n) => [tok('MII', B64 + '+/', n), tok('MII', B64 + '+/', n) + '==']),
  ...[15, 16, 17, 64].map((n) => `${HR}\n${randFrom(B64 + '+/=', n)}`),
  ...[7, 8, 9, 40].flatMap((n) => [`${P}=${randFrom(B64, n)}`, `apikey = "${randFrom(B64, n)}"`, `TOKEN: '${randFrom(B64, n)}'`]),
  ...[9, 10, 11, 60].flatMap((n) => [`Authorization: Basic ${randFrom(B64 + '+/=', n)}`, `auth:Basic    ${randFrom(B64, n)}`]),
  // the rest of the table, unchanged shapes, so consumers are compared whole
  `export API_KEY=${randFrom(B64, 16)}`, `aws AK` + `IA${randFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}`,
  tok('gh' + 'p_', B64, 36), tok('gl' + 'pat-', B64, 20), tok('GOC' + 'SPX-', B64, 20),
  'root:$6$xyz$hashedvalue:19000:0:99999:7:::', 'aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0',
  'nothing sensitive here', ''
]

describe('the linear rewrite changes no match', () => {
  it('keeps every shape\'s flags', () => {
    for (const id of IDS) expect({ id, flags: SECRET_SHAPES[id].pattern.flags }).toEqual({ id, flags: OLD[id][1] })
  })

  it(`matches, redacts and records loot exactly as before on ${REALISTIC.length} realistic inputs`, () => {
    for (const text of REALISTIC) expectSameEverywhere(text)
    // and on all of them at once, as one captured output
    expectSameEverywhere(REALISTIC.join('\n'))
    expectSameEverywhere(REALISTIC.join(' '))
  })

  it('matches exactly as before on random inputs built from each shape\'s own pieces', () => {
    const families: string[][] = [
      [J, 'ey', 'J', 'a', 'Z', '0', '-', '_', '.', ' ', '=', '\n', '"', 'aaaaaaaaaa', HDR, PAY, 'x'],
      ['http', 's', '+', '://', ':', '@', '/', 'a', 'B', ' ', '\n', 'x', '.', 'user', PW, '@host', '9'],
      [H, HR, F, FR, '-----', '-', 'BEGIN', 'END', ' PRIV' + 'ATE KEY', 'PRIV' + 'ATE KEY-----', '-----BEGIN', '-----END', 'RSA ', '\n', 'MIIB', ' ', 'x'],
      ['sk-', 'sk_live_', 'xo' + 'xb-', 'np' + 'm_', 'h' + 'f_', 'MII', P, 'apikey', 'token', 'secret', 'auth', 'Authorization',
        ':', '=', ' ', '"', "'", 'Basic ', HR, '\n', '+', '/', '==', ...[1, 5, 9, 10, 15, 16, 19, 20, 35, 36, 99, 100].map((n) => 'A'.repeat(n))]
    ]
    let cases = 0
    for (const pieces of families) {
      for (let i = 0; i < 600; i++) {
        const n = 1 + Math.floor(rnd() * 40)
        const text = Array.from({ length: n }, () => pieces[Math.floor(rnd() * pieces.length)]).join('')
        expectSameEverywhere(text)
        cases++
      }
    }
    expect(cases).toBe(2400)
  })
})

// ─── Work bound ─────────────────────────────────────────────────────────────

const rep = (s: string, n: number): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const lead = (head: string, fill: string) => (n: number): string => head + rep(fill, n - head.length)
const run = (s: string) => (n: number): string => rep(s, n)
// Adversarial inputs per shape: long runs of its own prefix, of its character
// class, and near-misses that fail only at the end.
const ADVERSARIAL: Record<SecretShapeId, Array<[string, (n: number) => string]>> = {
  named_secret_assignment: [['token*', run('token')], ['(token )*', run('token ')], ['token sp*', lead('token', ' ')]],
  bearer_token: [['bearer*', run('bearer ')], ['bearer sp*', lead('bearer', ' ')]],
  aws_access_key: [['AKIA*', run('AK' + 'IA')], ['A*', run('A')]],
  prefixed_api_key: [['sk-*', run('sk-')], ['sk- a* !', (n) => lead('sk-', 'a')(n - 1) + '!']],
  private_key_block: [['BEGIN*', run(H + '\n')], ['-BEGIN*', run('-' + H)], ['(END-BEGIN x)*', run(F.slice(0, -5) + H + 'x')], ['BEGIN A*', lead('-----BEGIN', 'A')]],
  jwt_three_segment: [[`${J}*`, run(J)], [`${J} a*`, lead(J, 'a')], [`${J}a.${J}*`, lead(J + 'a.', J)], [`(${J}a{10}.)*`, run(J + 'aaaaaaaaaa.')], [`(x${J})*`, run('x' + J)]],
  github_pat: [['ghp_*', run('gh' + 'p_')], ['a*', run('a')]],
  gitlab_pat: [['glpat-*', run('gl' + 'pat-')], ['a*', run('a')]],
  slack_token: [['xoxb-*', run('xo' + 'xb-')], ['a*', run('a')]],
  npm_token: [['npm_*', run('np' + 'm_')], ['npm_ a*', lead('np' + 'm_', 'a')]],
  huggingface_token: [['hf_*', run('h' + 'f_')], ['hf_ a*', lead('h' + 'f_', 'a')]],
  google_oauth_client_secret: [['GOCSPX-*', run('GOC' + 'SPX-')]],
  uri_userinfo_credentials: [['a*', run('a')], ['A*', run('A')], ['(a://b:)*', run('a://b:')], ['x:// y:*', lead('x://', 'y:')]],
  der_base64_key: [['MII*', run('MII')], ['(MII a{99} .)*', run('MII' + 'a'.repeat(99) + '.')]],
  crypt_password_hash: [['$1*', run('$1')], ['$1$*', run('$1$')], ['$1 $a*', lead('$1', '$a')]],
  ntlm_hash_pair: [['hex*', run('a')], ['(hex31:)*', run('a'.repeat(31) + ':')]],
  private_key_header: [['BEGIN*', run(HR + '\n')], ['BEGIN sp*', lead('-----BEGIN', ' ')]],
  jwt_with_json_payload: [[`${J}*`, run(J)], [`${J}a.${J}*`, lead(J + 'a.', J)], [`(${J}a.)*`, run(J + 'a.')], [`(x${J})*`, run('x' + J)]],
  named_secret_value: [[`${P}=*`, run(P + '=')], ['(apikey ")*', run('apikey="')], ['secret:*', run('secret:')], [`${P} sp*`, lead(P, ' ')]],
  database_url: [['mysql://*', run('mysql://')], [':*', run(':')]],
  shadow_entry: [['(a:$x:nl)*', run('a:$x:\n')], ['(a:$)*', run('a:$')], ['a:$ x*', lead('a:$', 'x')]],
  basic_auth_header: [['auth: Basic sp*', lead('auth: Basic', ' ')], ['auth:*', run('auth:')]]
}

function bestOf(times: number, fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < times; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('every built-in shape is linear', () => {
  // Wall-clock, so the bound is a ratio, not a number of milliseconds: four
  // times the input may take at most eleven times as long (linear is 4x,
  // quadratic 16x; the slack is for a shared CI runner). The base size grows until a run takes long enough to time;
  // each case is retried, so a GC pause on a loaded runner does not fail it.
  it('takes at most 11x as long on 4x the adversarial input', () => {
    const failures: string[] = []
    for (const id of IDS) {
      const re = compileShape(id)
      const scan = (text: string) => () => { allMatches(re, text) }
      for (const [name, make] of ADVERSARIAL[id]) {
        let ok = false
        let last = ''
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          let n = 16 * 1024
          let t = bestOf(2, scan(make(n)))
          while (t < 4 && n < 1024 * 1024) { n *= 4; t = bestOf(2, scan(make(n))) }
          const t4 = bestOf(2, scan(make(4 * n)))
          ok = t4 <= 11 * Math.max(t, 0.5)
          last = `${id} [${name}] ${n >> 10} KiB ${t.toFixed(1)} ms -> ${(4 * n) >> 10} KiB ${t4.toFixed(1)} ms`
        }
        if (!ok) failures.push(last)
      }
    }
    expect(failures).toEqual([])
  }, 120_000)

  // A counted `X{n,}` keeps backtracking state on the stack for every
  // character it takes; at a few MiB V8 threw instead of matching.
  it('does not throw on an 8 MiB match', () => {
    const N = 8 * 1024 * 1024
    const long = (head: string, fill: string, tail = ''): string => head + rep(fill, N) + tail
    const cases: Array<[SecretShapeId, string]> = [
      ['prefixed_api_key', long('sk-', 'a')],
      ['jwt_three_segment', long(J, 'a', '.' + 'b'.repeat(10) + '.' + 'c'.repeat(10))],
      ['slack_token', long('xo' + 'xb-', 'a')],
      ['npm_token', long('np' + 'm_', 'a')],
      ['huggingface_token', long('h' + 'f_', 'a')],
      ['der_base64_key', long('MII', 'a')],
      ['private_key_header', long(HR + '\n', 'A')],
      ['named_secret_value', long(P + '=', 'a')],
      ['basic_auth_header', long('auth: Basic ', 'a')]
    ]
    const threw: string[] = []
    for (const [id, text] of cases) {
      try {
        expect({ id, found: allMatches(compileShape(id), text).length }).toEqual({ id, found: 1 })
      } catch (e) {
        if (!(e instanceof RangeError)) throw e
        threw.push(`${id}: ${e.message}`)
      }
    }
    expect(threw).toEqual([])
  }, 60_000)
})
