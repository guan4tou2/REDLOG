import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadConfig } from '../src/core/config'

// docs/TESTING.md Part 2: every default its tables list, one `it` per option,
// named after the option's key, read the way a new project reads them —
// loadConfig on a project directory with no config.yaml. A changed default
// fails its own named test here, not a distant integration.
//
// The table is also held against the real defaults: an option loadConfig
// returns that the table does not name fails, and so does a table entry whose
// option has gone. Adding an option means adding it here and to Part 2.

type Check = unknown | ((value: unknown) => void)

const DEFAULTS: Record<string, Check> = {
  // 2.1 engagement / operator
  'engagement.id': 'default',
  'engagement.activeTarget': null,
  'operator.id': 'operator-1',
  'operator.name': 'Operator',

  // 2.2 network
  'network.whitelist': [],
  'network.blacklist': [],
  'network.checkInterval': 60,
  'network.providers': [],
  'network.confirmations': 3,
  'network.ipMode': 'auto',
  'network.offline': false,
  'network.showWifiName': false,
  'network.vpnAdapters': (value: unknown) => {
    const adapters = value as Array<{ enabled: boolean }>
    expect(adapters).toHaveLength(12)
    expect(adapters.every((a) => a.enabled)).toBe(true)
  },

  // 2.3 scope
  'scope.warnOnViolation': true,
  'scope.targets': [],
  'scope.excludeTargets': [],
  'scope.personalDomains': ['127.0.0.0/8', '::1', 'localhost'],
  'scope.scopeFile': null,

  // 2.4 screenshot
  'screenshot.quality': 85,
  'screenshot.intervalSec': 0,
  'screenshot.diffThreshold': 5,
  'screenshot.captureOnCommand': false,

  // 2.5 overlay
  'overlay.showMarkButton': true,
  'overlay.showInDock': true,
  'overlay.flashOnExposed': true,
  'overlay.scale': 1.0,
  'overlay.emphasizeExternalIp': false,
  'overlay.passThrough': false,
  'overlay.passThroughOpacity': 0.4,

  // 2.6 terminal / retention
  'terminal.maxCastBytes': 52_428_800,
  'retention.casts.keepDays': 0,
  'retention.screenshots.keepDays': 0,
  'retention.httpBodies.keepDays': 0,
  'retention.agentTranscripts.keepDays': 0,
  'retention.casts.maxBytes': 0,
  'retention.screenshots.maxBytes': 0,
  'retention.httpBodies.maxBytes': 0,
  'retention.loggedTier.keepDays': 0,
  'retention.loggedTier.sweepIntervalHours': 24,
  'retention.bookmarks.keepDays': 0,

  // 2.7 clipboard
  'clipboard.pollMs': 1500,
  'clipboard.storePreview': false,

  // 2.8 browser
  'browser.binary': '',
  'browser.proxy': 'http://127.0.0.1:8080',
  'browser.cdpPort': 9222,
  'browser.isolateProfile': true,
  'browser.ignoreCertErrors': true,
  'browser.startUrl': '',
  'browser.extraArgs': [],

  // 2.8a httpCapture
  'httpCapture.port': 8080,
  'httpCapture.routeTerminals': false,

  // 2.9 redaction
  'redaction.entropyThreshold': 4.5,
  'redaction.minLength': 20,
  'redaction.denylist': [],
  'redaction.allowlist': [],

  // 2.12 fileWatcher / processMonitor / connectionMonitor / agentTailer
  'fileWatcher.watchPaths': [],
  'fileWatcher.ignorePatterns': [],
  'processMonitor.pollMs': 500,
  'processMonitor.ignoreCommands': [],
  'connectionMonitor.pollMs': 2000,
  'agentTailer.emitThinking': false,

  // 2.12a packs
  'packs.hostMonitors': false,
  'packs.aiAgents': false,
  'packs.windowsOutput': false,

  // 2.13 loot
  'loot.disabledRules': ['jwt', 'generic_api_key']
}

/** The value at a dotted key, or undefined when any step is missing. */
const at = (config: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, step) => (node as Record<string, unknown> | undefined)?.[step], config)

/** Every option's dotted key: a leaf is anything that is not a plain object,
 *  so a list such as `network.vpnAdapters` is one option. */
function optionKeys(node: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? optionKeys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`])
}

let projectDir: string
beforeAll(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-config-options-')) })
afterAll(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

describe('config defaults (docs/TESTING.md Part 2)', () => {
  for (const [key, check] of Object.entries(DEFAULTS)) {
    it(key, () => {
      const value = at(loadConfig(projectDir), key)
      if (typeof check === 'function') (check as (v: unknown) => void)(value)
      else expect(value).toEqual(check)
    })
  }

  it('names every option the defaults hold, and nothing they do not', () => {
    const actual = optionKeys(loadConfig(projectDir) as unknown as Record<string, unknown>).sort()
    expect(actual).toEqual(Object.keys(DEFAULTS).sort())
  })
})
