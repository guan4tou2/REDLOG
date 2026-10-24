import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

// Shared local exclusions only. Capture permission belongs to each project
// and each installed AI source; this file never grants a working directory.

export interface HookConfig {
  excludedPaths: string[]
}

export const HOOK_CONFIG_PATH = path.join(homedir(), '.redlog', 'hook-config.json')

const clean = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((s) => String(s).trim()).filter(Boolean) : []

export function readHookConfig(file = HOOK_CONFIG_PATH): HookConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<HookConfig>
    return { excludedPaths: clean(raw.excludedPaths) }
  } catch (e) {
    // A missing or malformed file is expected — the operator may never have
    // opened Settings. Anything else gets logged: v0.9.4 P0-1 was a
    // ReferenceError swallowed at this read for several releases, silently
    // disabling every tailer exclusion. A gate that fails open must not fail
    // quietly.
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    if (!missing && !(e instanceof SyntaxError)) {
      console.error('[tailer] hook-config.json unreadable; path exclusions disabled:', e)
    }
    return { excludedPaths: [] }
  }
}

// An omitted exclusion list preserves the stored restriction.
export function saveHookConfig(cfg: Partial<HookConfig>, file = HOOK_CONFIG_PATH): HookConfig {
  const current = readHookConfig(file)
  const next = {
    excludedPaths: cfg.excludedPaths === undefined ? current.excludedPaths : clean(cfg.excludedPaths)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return next
}
