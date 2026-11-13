// What "import a profile" means on the create-project card (#297).
//
// A profile file is the engagement's scope and nothing else: `version: 1`, and
// under `scope` the target list and the exclusion list. The file is read
// strictly. `version` must be exactly 1, and any other key, at the top or under
// `scope`, refuses the whole file and is named: a file that still carries the
// operator's IP lists or the violation warning is not applied in part, it is
// refused, so nobody believes they imported a setting that was dropped.
//
// Importing REPLACES. A list the file leaves out is empty, never what an
// earlier import put there; and the summary shown to the operator and the
// config handed to project.create are both derived from this one resolved
// value, so they cannot disagree.
//
// No old-shape shims (v0): the file is read as the current contract, and a
// field of the wrong type is a named validation error rather than a guess.
//
// Pure, and free of fs/yaml, because the renderer imports it too.

export interface ImportedProfile {
  scope: { targets: string[]; excludeTargets: string[] }
}

export type ProfileFailure =
  /** the file could not be opened or read; `detail` is the OS message */
  | { code: 'read'; detail: string }
  /** the text is not YAML/JSON; `detail` is the parser's message */
  | { code: 'parse'; detail: string }
  /** the file parsed, but `field` is not the `expected` kind */
  | { code: 'shape'; field: string; expected: 'object' | 'list' }
  /** `version` is missing (`found` null) or is not 1; `found` is what it holds, as JSON */
  | { code: 'version'; found: string | null }
  /** keys this version does not define, as `key` or `scope.key`, in file order */
  | { code: 'unknown'; fields: string[] }
  /** the file parsed and holds neither list */
  | { code: 'empty' }

/** What `config:importProfile` answers. Cancelling the picker and failing to
 *  import are different outcomes: only the second wants an explanation. */
export type ProfileImportResult =
  | { status: 'cancelled' }
  | { status: 'imported'; profile: ImportedProfile }
  | { status: 'failed'; failure: ProfileFailure }

/** Same values as DEFAULT_CONFIG; a test holds them together. */
function defaultProfile(): ImportedProfile {
  return { scope: { targets: [], excludeTargets: [] } }
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

const unknownKeys = (obj: Record<string, unknown> | undefined, known: string[], prefix: string): string[] =>
  obj ? Object.keys(obj).filter((k) => !known.includes(k)).map((k) => prefix + k) : []

/** Validate parsed file contents into the one resolved profile. */
export function resolveProfile(data: unknown): { ok: true; profile: ImportedProfile } | { ok: false; failure: ProfileFailure } {
  if (!isRecord(data)) return { ok: false, failure: { code: 'shape', field: '(file)', expected: 'object' } }

  if (data.version !== 1) {
    return { ok: false, failure: { code: 'version', found: data.version === undefined ? null : JSON.stringify(data.version) ?? String(data.version) } }
  }

  const scopeR = section(data, 'scope')
  if ('failure' in scopeR) return { ok: false, failure: scopeR.failure }
  const scope = scopeR.value

  const fields = [...unknownKeys(data, ['version', 'scope'], ''), ...unknownKeys(scope, ['targets', 'excludeTargets'], 'scope.')]
  if (fields.length) return { ok: false, failure: { code: 'unknown', fields } }

  const targets = list(scope, 'scope', 'targets')
  if ('failure' in targets) return { ok: false, failure: targets.failure }
  const exclude = list(scope, 'scope', 'excludeTargets')
  if ('failure' in exclude) return { ok: false, failure: exclude.failure }

  // Replace, never merge: start from the defaults and lay on only what the
  // file says.
  const profile = defaultProfile()
  let seen = 0
  if (targets.value) { profile.scope.targets = targets.value; seen++ }
  if (exclude.value) { profile.scope.excludeTargets = exclude.value; seen++ }

  if (seen === 0) return { ok: false, failure: { code: 'empty' } }
  return { ok: true, profile }
}

/** The `initialConfig` for project.create. Whatever is in the profile goes
 *  across as it is, empty lists included: whether to pass it at all is decided
 *  by whether a profile was imported, never by what it contains. Network and
 *  the violation warning are not sent, so a new project keeps their defaults. */
export function profileToInitialConfig(profile: ImportedProfile): {
  scope: ImportedProfile['scope'] & { scopeFile: null; personalDomains: string[] }
} {
  return { scope: { ...profile.scope, scopeFile: null, personalDomains: [] } }
}

export type AppliedKey = 'project.appliedScope' | 'project.appliedExcluded'

/** What the card names after an import: each list that is not empty, since
 *  neither is visible on the card itself. */
export function profileSummary(profile: ImportedProfile): Array<{ key: AppliedKey; count: number }> {
  const out: Array<{ key: AppliedKey; count: number }> = []
  if (profile.scope.targets.length) out.push({ key: 'project.appliedScope', count: profile.scope.targets.length })
  if (profile.scope.excludeTargets.length) out.push({ key: 'project.appliedExcluded', count: profile.scope.excludeTargets.length })
  return out
}
