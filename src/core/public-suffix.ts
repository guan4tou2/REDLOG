// Registrable-domain derivation for scope adjacency (`ALERT-ROLES.md` B.4, G-B2).
//
// The D2 `adjacent_domain` rule asks "is this host under the same *registrable*
// domain as a scope entry?" The previous answer — take the last two labels —
// makes `co.uk` the registrable domain of `shop.example.co.uk`, so a scope of
// `*.example.co.uk` marks every `.co.uk` host on the internet as adjacent. The
// same bug hits `github.io`, `s3.amazonaws.com` and `azurewebsites.net`, which
// matters more in practice: a scope of `target.github.io` would otherwise make
// every GitHub Pages site a near-miss.
//
// WHY A CURATED TABLE AND NOT THE FULL PUBLIC SUFFIX LIST
//
// The full PSL means a runtime dependency (tldts/psl, ~3 MB). RedLog ships eight
// runtime dependencies on purpose; for an evidence tool, supply-chain surface is
// a cost paid by every user. The deciding factor is the failure direction:
//
//   * A suffix MISSING from this table → the fallback takes the last two labels
//     → over-match → a noisier D2. That is exactly today's behaviour, so an
//     incomplete table degrades to the status quo and never below it.
//   * A suffix WRONGLY in this table → hosts that share an owner get different
//     registrable domains → D3 → SILENCE. For an alerting subsystem with no
//     second line of defence, that is the unacceptable direction.
//
// So the table is deliberately conservative: only entries that are unambiguously
// public suffixes. Anything doubtful is left out (costing noise, not silence) and
// operators extend it per engagement via `scope.publicSuffixes`.

/** Multi-label public suffixes. Single-label TLDs (`com`, `io`, `dev`) are NOT
 *  listed — the fallback already handles them by taking the last two labels. */
const BUILT_IN_SUFFIXES: readonly string[] = [
  // --- ccTLD second levels ---
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk', 'mod.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw', 'game.tw', 'ebiz.tw', 'club.tw',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'co.kr', 'or.kr', 'ne.kr', 're.kr', 'pe.kr', 'go.kr', 'ac.kr', 'mil.kr',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'per.sg',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in', 'res.in', 'mil.in',
  'co.id', 'or.id', 'net.id', 'web.id', 'ac.id', 'go.id', 'sch.id', 'my.id', 'biz.id',
  'co.th', 'in.th', 'ac.th', 'go.th', 'or.th', 'net.th',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my', 'mil.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn', 'ac.vn',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'mil.br',
  'com.ar', 'net.ar', 'org.ar', 'gov.ar', 'edu.ar', 'int.ar', 'mil.ar',
  'com.mx', 'org.mx', 'net.mx', 'edu.mx', 'gob.mx',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'web.za', 'edu.za', 'mil.za',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'mil.tr', 'k12.tr', 'bel.tr', 'pol.tr',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il', 'idf.il',
  'com.ru', 'net.ru', 'org.ru', 'edu.ru',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua', 'in.ua',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  'gov.it', 'edu.it',

  // --- Platform / SaaS suffixes. Under the old rule a scope of
  //     `target.github.io` made every GitHub Pages site adjacent; in bug-bounty
  //     and red-team scopes these matter more than the ccTLDs above.
  'github.io', 'gitlab.io',
  'pages.dev', 'workers.dev', 'r2.dev',
  'vercel.app', 'netlify.app',
  'herokuapp.com',
  'appspot.com', 'web.app', 'firebaseapp.com', 'cloudfunctions.net',
  'azurewebsites.net', 'blob.core.windows.net', 'azureedge.net',
  'cloudfront.net', 's3.amazonaws.com', 'elasticbeanstalk.com', 'amplifyapp.com',
  'onrender.com', 'fly.dev',
  'glitch.me', 'repl.co', 'replit.dev', 'surge.sh', 'readthedocs.io'
  // Known gap: regional S3 forms (`s3.us-east-1.amazonaws.com`) are absent, so
  // they fall back to `amazonaws.com`. That over-matches — noise, not silence.
]

export function buildSuffixSet(extra: readonly string[] = []): Set<string> {
  const set = new Set(BUILT_IN_SUFFIXES)
  for (const s of extra) {
    const trimmed = s.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+|\.+$/g, '')
    if (trimmed.includes('.')) set.add(trimmed)
  }
  return set
}

export const DEFAULT_SUFFIXES: Set<string> = buildSuffixSet()

/** The registrable domain: the public suffix plus one label. Longest suffix
 *  wins, so `example.co.uk` beats a hypothetical bare `uk` entry. Falls back to
 *  the last two labels when no multi-label suffix matches — which is correct for
 *  every ordinary TLD (`example.com`) and is the safe over-matching default for
 *  any suffix the table has not heard of. */
export function getRegistrableDomain(host: string, suffixes: Set<string> = DEFAULT_SUFFIXES): string {
  const labels = host.toLowerCase().split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')

  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.')
    if (!suffixes.has(candidate)) continue
    // The host IS the suffix (`co.uk`) — there is nothing shorter to return.
    return i === 0 ? candidate : labels.slice(i - 1).join('.')
  }
  return labels.slice(-2).join('.')
}
