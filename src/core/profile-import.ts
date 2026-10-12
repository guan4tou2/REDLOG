// What "import a profile" means on the create-project card (#297).
//
// A profile file is a whole exported config, but the card carries only the five
// settings a new project can take from it: the scope list, the exclusions, the
// violation warning, and the two IP lists. Everything else in the file is
// ignored, not rejected, because an exported profile contains all of it.
//
// Importing REPLACES. A field the file leaves out is the default, never what an
// earlier import put there; and the summary shown to the operator and the
// config handed to project.create are both derived from this one resolved
// value, so they cannot disagree.
//
// No old-shape shims (v0): the file is read as the current contract, and a
// field of the wrong type is a named validation error rather than a guess.
//
// Pure, and free of fs/yaml, because the renderer imports it too.

export interface ImportedProfile {
  scope: { targets: string[]; excludeTargets: string[]; warnOnViolation: boolean }
  network: { whitelist: string[]; blacklist: string[] }
}

export type ProfileFailure =
  /** the file could not be opened or read; `detail` is the OS message */
  | { code: 'read'; detail: string }
  /** the text is not YAML/JSON; `detail` is the parser's message */
  | { code: 'parse'; detail: string }
  /** the file parsed, but `field` is not the `expected` kind */
  | { code: 'shape'; field: string; expected: 'object' | 'list' | 'boolean' }
  /** the file parsed and holds none of the five settings */
  | { code: 'empty' }

/** What `config:importProfile` answers. Cancelling the picker and failing to
 *  import are different outcomes: only the second wants an explanation. */
export type ProfileImportResult =
  | { status: 'cancelled' }
  | { status: 'imported'; profile: ImportedProfile }
  | { status: 'failed'; failure: ProfileFailure }

/** Same values as DEFAULT_CONFIG; a test holds them together. */
function defaultProfile(): ImportedProfile {
  return {
    scope: { targets: [], excludeTargets: [], warnOnViolation: true },
    network: { whitelist: [], blacklist: [] }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

type Read<T> = { value: T } | { failure: ProfileFailure }

/** Read one optional section. Absent is fine; present and not an object is not. */
function section(parent: Record<string, unknown>, key: string): Read<Record<string, unknown> | undefined> {
  const v = parent[key]
  if (v === undefined) return { value: undefined }
  if (!isRecord(v)) return { failure: { code: 'shape', field: key, expected: 'object' } }
  return { value: v }
}

function list(sec: Record<string, unknown> | undefined, parentKey: string, key: string): Read<string[] | undefined> {
  const v = sec?.[key]
  if (v === undefined) return { value: undefined }
  const field = `${parentKey}.${key}`
  if (!Array.isArray(v)) return { failure: { code: 'shape', field, expected: 'list' } }
  const bad = v.findIndex((x) => typeof x !== 'string')
  if (bad >= 0) return { failure: { code: 'shape', field: `${field}[${bad}]`, expected: 'list' } }
  return { value: [...(v as string[])] }
}

/** Validate parsed file contents into the one resolved profile. */
export function resolveProfile(data: unknown): { ok: true; profile: ImportedProfile } | { ok: false; failure: ProfileFailure } {
  if (!isRecord(data)) return { ok: false, failure: { code: 'shape', field: '(file)', expected: 'object' } }

  const scopeR = section(data, 'scope')
  if ('failure' in scopeR) return { ok: false, failure: scopeR.failure }
  const networkR = section(data, 'network')
  if ('failure' in networkR) return { ok: false, failure: networkR.failure }
  const scope = scopeR.value
  const network = networkR.value

  const targets = list(scope, 'scope', 'targets')
  if ('failure' in targets) return { ok: false, failure: targets.failure }
  const exclude = list(scope, 'scope', 'excludeTargets')
  if ('failure' in exclude) return { ok: false, failure: exclude.failure }
  const allow = list(network, 'network', 'whitelist')
  if ('failure' in allow) return { ok: false, failure: allow.failure }
  const deny = list(network, 'network', 'blacklist')
  if ('failure' in deny) return { ok: false, failure: deny.failure }

  const warn = scope?.warnOnViolation
  if (warn !== undefined && typeof warn !== 'boolean') {
    return { ok: false, failure: { code: 'shape', field: 'scope.warnOnViolation', expected: 'boolean' } }
  }

  // Replace, never merge: start from the defaults and lay on only what the
  // file says.
  const profile = defaultProfile()
  let seen = 0
  if (targets.value) { profile.scope.targets = targets.value; seen++ }
  if (exclude.value) { profile.scope.excludeTargets = exclude.value; seen++ }
  if (allow.value) { profile.network.whitelist = allow.value; seen++ }
  if (deny.value) { profile.network.blacklist = deny.value; seen++ }
  if (warn !== undefined) { profile.scope.warnOnViolation = warn; seen++ }

  if (seen === 0) return { ok: false, failure: { code: 'empty' } }
  return { ok: true, profile }
}

/** The `initialConfig` for project.create. Whatever is in the profile goes
 *  across as it is, `false` and empty lists included: whether to pass it at all
 *  is decided by whether a profile was imported, never by what it contains. */
export function profileToInitialConfig(profile: ImportedProfile): {
  scope: ImportedProfile['scope'] & { scopeFile: null; personalDomains: string[] }
  network: ImportedProfile['network'] & { checkInterval: number }
} {
  return {
    scope: { ...profile.scope, scopeFile: null, personalDomains: [] },
    network: { ...profile.network, checkInterval: 60 }
  }
}

export type AppliedKey =
  | 'project.appliedScope'
  | 'project.appliedExcluded'
  | 'project.appliedSafe'
  | 'project.appliedExposed'
  | 'project.appliedNoWarn'

/** What the card names after an import: every setting that differs from the
 *  defaults, since none of it is visible on the card itself. */
export function profileSummary(profile: ImportedProfile): Array<{ key: AppliedKey; count?: number }> {
  const out: Array<{ key: AppliedKey; count?: number }> = []
  if (profile.scope.targets.length) out.push({ key: 'project.appliedScope', count: profile.scope.targets.length })
  if (profile.scope.excludeTargets.length) out.push({ key: 'project.appliedExcluded', count: profile.scope.excludeTargets.length })
  if (profile.network.whitelist.length) out.push({ key: 'project.appliedSafe', count: profile.network.whitelist.length })
  if (profile.network.blacklist.length) out.push({ key: 'project.appliedExposed', count: profile.network.blacklist.length })
  if (!profile.scope.warnOnViolation) out.push({ key: 'project.appliedNoWarn' })
  return out
}
