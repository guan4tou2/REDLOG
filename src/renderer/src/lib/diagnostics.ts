// Diagnostic bundles for crash reports (docs/UIUX-STANDARD.md §9).
//
// The useful part of a crash report is the stack, and a stack is full of
// absolute paths. On a red-team engagement those paths carry the operator's
// username, the client's name in a project folder, sometimes the engagement
// codename — straight into a GitHub issue that is public forever. So nothing
// is assembled without being scrubbed first, and §9 requires the operator see
// the exact text before it leaves the machine.
//
// Scrubbing is deliberately conservative: it would rather leave a stack less
// readable than let one identifier through. Everything below `app.asar` is a
// path inside the bundle and is safe; everything above it is the machine.

export interface DiagnosticInput {
  version: string
  platform: string
  view: string
  error: Error | { message: string; stack?: string }
  /** Scrubbed out by name — the operator's own account and project. */
  user?: string
  project?: string
}

const HOME_PREFIXES = [
  /(?:\/Users\/|\/home\/)[^/\s'"]+/g,          // macOS, Linux
  /[A-Za-z]:\\Users\\[^\\\s'"]+/g              // Windows
]

/**
 * Reduce a path to what is diagnostic. Anything inside the packaged app keeps
 * its bundle-relative tail; anything else loses its user segment.
 */
export function scrubPath(text: string): string {
  let out = text
  // Inside the bundle: keep only what follows app.asar, which is the part
  // that identifies the code. The prefix may contain spaces — the default
  // Windows install lives under `C:\Program Files\` — so this cannot be
  // written as "run of non-whitespace". Brackets and quotes are excluded
  // instead, since those are what a stack frame wraps the path in.
  out = out.replace(/(?:[A-Za-z]:)?[\\/][^\n'"()]*?app\.asar/g, 'app.asar')
  for (const re of HOME_PREFIXES) out = out.replace(re, '<user>')
  return out
}

/** Replace the operator's and project's own names wherever they appear. */
export function scrubNames(text: string, names: { user?: string; project?: string }): string {
  let out = text
  // Longest first: a project named "op" would otherwise chew through words.
  const subs: Array<[string, string]> = [
    ...(names.project ? [[names.project, '<project>'] as [string, string]] : []),
    ...(names.user ? [[names.user, '<user>'] as [string, string]] : [])
  ].sort((a, b) => b[0].length - a[0].length)
  for (const [needle, token] of subs) {
    if (needle.length < 3) continue // too short to match safely
    out = out.split(needle).join(token)
  }
  return out
}

/** The full text, exactly as it will be shared. Show this before sending. */
export function buildDiagnostics(input: DiagnosticInput): string {
  const stack = input.error.stack ?? input.error.message
  const body = [
    `RedLog ${input.version}`,
    `Platform: ${input.platform}`,
    `View: ${input.view}`,
    '',
    scrubPath(scrubNames(stack, { user: input.user, project: input.project }))
  ].join('\n')
  return body
}

/** A GitHub issue URL with the diagnostics prefilled. */
export function issueUrl(repo: string, title: string, diagnostics: string): string {
  const body = ['<!-- What were you doing when this happened? -->', '', '```', diagnostics, '```'].join('\n')
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}
