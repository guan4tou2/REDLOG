// Turning a chosen profile file into a ProfileImportResult (#297). Kept apart
// from profile-import.ts because it needs yaml, which the renderer must not
// pull in.

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { resolveProfile, type ProfileImportResult } from './profile-import'

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0]

export function readProfileFile(filePath: string): ProfileImportResult {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    return { status: 'failed', failure: { code: 'read', detail: firstLine(e) } }
  }
  let data: unknown
  try {
    data = path.extname(filePath).toLowerCase() === '.json'
      ? JSON.parse(raw)
      : yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  } catch (e) {
    return { status: 'failed', failure: { code: 'parse', detail: firstLine(e) } }
  }
  const res = resolveProfile(data)
  return res.ok ? { status: 'imported', profile: res.profile } : { status: 'failed', failure: res.failure }
}
