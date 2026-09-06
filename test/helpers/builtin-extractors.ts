import fs from 'fs'
import path from 'path'
import { registerTargetExtractors, unregisterTargetExtractors } from '../../src/core/target-extractor'

// E1 Option B: the built-in tool→target table no longer lives in core — it is
// the bundled `builtin-tools` pack, loaded through the plugin runtime at
// startup. Unit tests that assert built-in extraction (target-extractor,
// pivot-detector) don't boot the plugin host, so they register the pack's rows
// directly here, with source 'bundled' (so a test's own 'user' extractor still
// overrides them, exactly as in production).

const PLUGIN_ID = 'builtin-tools'
const MANIFEST = path.join(process.cwd(), 'plugins', 'builtin-tools', 'plugin.json')

export function loadBuiltinTargetExtractors(): number {
  const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) as {
    contributes?: { targetExtractors?: Array<{ cmd: string; extract?: string; flags?: string; strategy?: string; param?: string }> }
  }
  const rows = raw.contributes?.targetExtractors ?? []
  return registerTargetExtractors(PLUGIN_ID, rows, 'bundled')
}

export function unloadBuiltinTargetExtractors(): void {
  unregisterTargetExtractors(PLUGIN_ID)
}
