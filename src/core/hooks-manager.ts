import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, rmdirSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import { homedir, tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { X509Certificate } from 'crypto'
import { bundledRoot } from './plugins/loader'
import { captureInstallProblem } from './plugins/manifest'
import { isOnPath } from './command-lookup'
import { isDisabled } from './plugins/state'
import { stopOpenTerminals } from './hook-removal'
import { readProfilePath } from './powershell-policy'

export type InstallMethod = 'claude-settings' | 'shell-source' | 'powershell-profile' | 'manual'

export interface PluginManifest {
  platforms?: Array<'darwin' | 'linux' | 'win32'>
  id: string
  name: string
  description: string
  agentType: string
  /** E3: event subtypes this producer emits under agentType (see CaptureContribution.emits). */
  emits?: string[]
  /** Any-of alternatives: available when at least one is on PATH. */
  requires: string[]
  /** All-of runtime dependencies: unavailable while any one is missing
   *  (the POSIX adapters build events with python3 and send them with curl). */
  requiresAll?: string[]
  hookFile: string
  /** Files installed beside hookFile, such as a shared shell transport. */
  supportFiles?: string[]
  installMethod: InstallMethod
  installTarget?: string
  shellRcFile?: string
  /** for installMethod 'manual', plugin-supplied setup steps (absolute paths filled at register time) */
  manualSteps?: ManualStep[]
  /** absolute plugin dir — set for capture entries contributed by a plugin. */
  _dir?: string
}

export interface ManualStep {
  /** what this step accomplishes */
  label: string
  /** copy-paste shell command, with the absolute hook path already resolved */
  command?: string
}

/** RedLog's mitmproxy CA, as the trust step installed it. Mirrors
 *  HttpCaptureStep.tsx's caUntrustCommand (renderer, so not importable here). */
export interface MitmproxyCa { path: string; sha1: string }

export function mitmproxyCaPath(home: string = homedir()): string {
  return join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem')
}

/** Null when the CA has not been generated: nothing was trusted, so there is
 *  nothing to untrust. */
export function readMitmproxyCa(path: string = mitmproxyCaPath()): MitmproxyCa | null {
  try {
    const cert = new X509Certificate(readFileSync(path))
    return { path, sha1: cert.fingerprint.replace(/:/g, '').toUpperCase() }
  } catch {
    return null
  }
}

export function caUntrustCommand(ca: MitmproxyCa, os: NodeJS.Platform = process.platform): string {
  if (os === 'win32') return `certutil -delstore -user Root ${ca.sha1}`
  if (os === 'darwin') return `sudo security remove-trusted-cert -d "${ca.path}"; sudo security delete-certificate -Z ${ca.sha1} /Library/Keychains/System.keychain`
  return `sudo rm -f /usr/local/share/ca-certificates/redlog-mitmproxy-${ca.sha1.slice(0, 16).toLowerCase()}.crt && sudo update-ca-certificates --fresh`
}

/** The path as the distro sees it, as the manual step and the WSL installer write it. */
function toWslPath(winPath: string): string {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Run inside the distro. Deletes only the lines RedLog's WSL install writes
 *  to the rc: the `# RedLog WSL hook` marker and `source "<hook>"` for the
 *  bash and zsh adapters. Matched whole-line and as fixed strings, so nothing
 *  else that merely mentions "redlog" (an alias, a PATH entry) is touched; `cat >`
 *  keeps a symlinked dotfile a symlink. */
function wslRcRemovalCommand(hookFile: string): string {
  const dir = hookFile.replace(/[\\/][^\\/]*$/, '')
  const lines = ['shell-bash-hook.sh', 'shell-zsh-hook.zsh'].map((f) => `source "${toWslPath(`${dir}/${f}`)}"`)
  const patterns = ['# RedLog WSL hook', ...lines].map((l) => `-e ${shQuote(l)}`).join(' ')
  return 'for f in ~/.bashrc ~/.zshrc; do [ -f "$f" ] || continue; '
    + `grep -vxF ${patterns} "$f" > "$f.redlog-tmp"; `
    + '[ $? -le 1 ] && cat "$f.redlog-tmp" > "$f"; rm -f "$f.redlog-tmp"; done'
}

// How to undo a source RedLog cannot uninstall for you.
//
// `uninstallHook` answered `Manual removal required for <name>` and stopped
// there — seven of the eleven sources said only that. For a tool that asks
// operators to care what they leave on a machine, and that tracks cleanup as
// evidence, "you figure it out" is the wrong half of the install to skip.
export function buildRemovalSteps(pluginId: string, ca: MitmproxyCa | null = readMitmproxyCa(), hookFile?: string): ManualStep[] | undefined {
  switch (pluginId) {
    case 'mitmproxy':
      return [
        // RedLog's managed proxy is stopped from the app, which does it on
        // its own handle. No kill-by-port or kill-by-name step: a port such as
        // 8080 belongs to whatever else the operator is running (Burp's default).
        { label: 'Stop RedLog\'s own proxy with Stop HTTP capture in RedLog' },
        { label: 'Stop the DNS instance too, if you started one',
          command: process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'mitmdump.exe\'\\" | Where-Object { $_.CommandLine -like \'*--mode dns*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId }"'
            : "pkill -f 'mitmdump -s .*--mode dns'" },
        { label: 'Point your browser and tools back off the proxy' },
        // If RedLog told the operator to trust a CA, RedLog owes them the
        // way to stop trusting it. A root certificate left in the store
        // after an engagement is the longest-lived thing this product can
        // leave on a machine, and it is the one nobody remembers. By
        // fingerprint, never by the name "mitmproxy": another tool's CA
        // shares it. The mitmproxy confdir (~/.mitmproxy) is shared with the
        // operator's own mitmproxy, so it is not offered for deletion.
        { label: 'Stop trusting RedLog\'s mitmproxy CA, if you added it to the system store',
          command: ca ? caUntrustCommand(ca) : undefined },
        { label: 'Optional - remove the tool itself',
          command: 'uv tool uninstall mitmproxy' }
      ]
    case 'shell-wsl':
      return [
        { label: 'Remove RedLog\'s hook lines from the shell rc, run inside the distro',
          command: hookFile ? wslRcRemovalCommand(hookFile) : undefined },
        { label: 'Open a new WSL shell so the change takes effect' }
      ]
    default:
      return undefined
  }
}

export interface PluginInfo {
  platforms?: Array<'darwin' | 'linux' | 'win32'>
  id: string
  name: string
  description: string
  agentType: string
  /** E3: event subtypes this producer emits under agentType, for feed health. */
  emits?: string[]
  installed: boolean
  available: boolean
  installMethod: InstallMethod
  hookFile: string
  /** for installMethod 'manual' (and the powershell-profile fallback): ordered, copy-paste setup steps */
  manualSteps?: ManualStep[]
  /** how to undo a source RedLog cannot uninstall itself */
  removalSteps?: ManualStep[]
  /** Contributed by a plugin the operator has switched off. */
  disabled?: boolean
  /** Shipped with RedLog, as opposed to contributed by an installed plugin.
   *  The Hooks page lists only these: a plugin's own capture belongs on the
   *  Plugins page, beside the plugin that brought it. */
  builtin: boolean
  /** The steps are an extra, not a setup. mitmproxy is installed and started
   *  by RedLog now; what is left is the optional second instance for DNS, and
   *  calling that "manual setup" says the capture needs work that it does
   *  not. */
  stepsAreOptional?: boolean
}

const HOOKS_DIR = join(__dirname, '../../../hooks')
function resolveDir(primary: string, fallback: string): string {
  return existsSync(primary) ? primary : fallback
}

// §8-2: the built-in producers are DECLARED in the bundled starter-pack
// manifest (plugins/starter-pack/plugin.json). This array is the FALLBACK — if
// that manifest is missing or unreadable in some build, hooks-manager uses this
// copy so capture can never go dark for want of a data file. The two must stay
// in sync; a parity test guards that. Kept as code, not deleted, precisely so
// the critical path has no single point of failure.
export const STARTER_PACK_FALLBACK: PluginManifest[] = [
  {
    id: 'shell-zsh',
    name: 'Zsh Shell',
    description: 'Captures commands and exit codes from zsh',
    agentType: 'shell',
    requires: [],
    requiresAll: ['python3', 'curl'],
    hookFile: 'hooks/shell-zsh-hook.zsh',
    supportFiles: ['hooks/shell-common.sh', 'hooks/redlog-session.py', 'hooks/redlog-relay.py', 'hooks/terminal_app.py', 'hooks/command-class.json'],
    installMethod: 'shell-source',
    installTarget: join(homedir(), '.redlog', 'shell-hook.zsh'),
    shellRcFile: '.zshrc'
  },
  {
    id: 'shell-bash',
    name: 'Bash Shell',
    description: 'Captures commands via preexec/precmd hooks',
    agentType: 'shell',
    requires: [],
    requiresAll: ['python3', 'curl'],
    hookFile: 'hooks/shell-bash-hook.sh',
    supportFiles: ['hooks/shell-common.sh', 'hooks/redlog-session.py', 'hooks/redlog-relay.py', 'hooks/terminal_app.py', 'hooks/command-class.json'],
    installMethod: 'shell-source',
    installTarget: join(homedir(), '.redlog', 'shell-bash-hook.sh'),
    shellRcFile: '.bashrc'
  },
  {
    id: 'mitmproxy',
    name: 'mitmproxy',
    description: 'Captures HTTP traffic via mitmproxy addon',
    agentType: 'http',
    requires: ['mitmproxy', 'mitmdump'],
    hookFile: 'hooks/mitmproxy-addon.py',
    installMethod: 'manual'
  },
  {
    id: 'shell-powershell',
    name: 'PowerShell',
    description: 'Captures commands from PowerShell via prompt hook',
    agentType: 'shell',
    requires: [],
    hookFile: 'hooks/shell-hook.ps1',
    installMethod: 'powershell-profile',
    installTarget: join(homedir(), '.redlog', 'shell-hook.ps1')
  },
  {
    id: 'shell-wsl',
    name: 'WSL (Bash)',
    description: 'Captures commands from WSL bash sessions — auto-resolves Windows token path',
    agentType: 'shell',
    requires: [],
    hookFile: 'hooks/shell-bash-hook.sh',
    supportFiles: ['hooks/shell-common.sh', 'hooks/redlog-session.py', 'hooks/redlog-relay.py', 'hooks/terminal_app.py', 'hooks/command-class.json'],
    installMethod: 'manual'
  }
]

/** §8-2: read the built-in producers from the bundled starter-pack manifest.
 *  `~` in installTarget is expanded to the home dir (a static JSON can't call
 *  homedir()). Returns null on ANY problem — missing file, bad JSON, or a
 *  malformed/empty list — so the caller falls back to the in-code copy and the
 *  critical capture path never depends on a data file being present. */
function loadStarterPack(): PluginManifest[] | null {
  try {
    const file = join(bundledRoot(), 'starter-pack', 'plugin.json')
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { builtinProducers?: unknown }
    const list = raw.builtinProducers
    if (!Array.isArray(list) || list.length === 0) return null
    const home = homedir()
    const out: PluginManifest[] = []
    for (const e of list as Array<Record<string, unknown>>) {
      if (typeof e.id !== 'string' || typeof e.hookFile !== 'string' || typeof e.agentType !== 'string'
        || typeof e.installMethod !== 'string') return null
      const installTarget = typeof e.installTarget === 'string'
        ? e.installTarget.replace(/^~(?=\/|$)/, home)
        : undefined
      out.push({
        id: e.id,
        name: typeof e.name === 'string' ? e.name : e.id,
        description: typeof e.description === 'string' ? e.description : '',
        agentType: e.agentType,
        requires: Array.isArray(e.requires) ? (e.requires as string[]) : [],
        requiresAll: Array.isArray(e.requiresAll) ? (e.requiresAll as string[]) : undefined,
        hookFile: e.hookFile,
        supportFiles: Array.isArray(e.supportFiles) ? (e.supportFiles as string[]) : undefined,
        installMethod: e.installMethod as PluginManifest['installMethod'],
        installTarget,
        shellRcFile: typeof e.shellRcFile === 'string' ? e.shellRcFile : undefined
      })
    }
    return out
  } catch { return null }
}

// The active registry: the starter-pack manifest when it loads, else the
// in-code fallback. Computed once at module load (the built-in set is static
// for a run). Bare ids are preserved — these ARE the built-ins, not namespaced
// plugin captures — so everything downstream (capture-health, the UI) that
// keys on `shell-zsh`/`mitmproxy` is unaffected.
const PLUGIN_REGISTRY: PluginManifest[] = loadStarterPack() ?? STARTER_PACK_FALLBACK

// Capture integrations contributed by plugins (🟢). Registered at load time and
// merged with the built-in registry, so plugin captures appear in the Hooks
// panel and can be installed/guided exactly like the built-ins.
const externalCaptures: PluginManifest[] = []

export function registerCapturePlugins(
  pluginId: string,
  dir: string,
  entries: Array<Omit<PluginManifest, 'requires'> & { requires?: string[] }>
): { accepted: number; rejected: Array<{ name: string; reason: string }> } {
  let accepted = 0
  const rejected: Array<{ name: string; reason: string }> = []
  for (const e of entries) {
    // #348: a capture entry with no id or no hook file cannot be installed or
    // run; it used to be registered as an empty row.
    if (!e.id || !e.hookFile) {
      rejected.push({ name: e.id || e.name || '(unnamed capture)', reason: 'needs both `id` and `hookFile`' })
      continue
    }
    // The manifest check already refuses these, and refuses the plugin. This
    // is the same rule again where the fields turn into file writes, because
    // this function is the way in for anything that does not come from a
    // loaded manifest.
    const problem = captureInstallProblem(e)
    if (problem) {
      rejected.push({ name: e.id, reason: problem })
      continue
    }
    // namespace the id so two plugins can't collide with each other or a built-in
    const id = e.id.startsWith(`${pluginId}.`) ? e.id : `${pluginId}.${e.id}`
    // A plugin names a file; where it goes is not the plugin's to say.
    const installTarget = e.installTarget ? join(homedir(), '.redlog', e.installTarget) : undefined
    externalCaptures.push({ ...e, id, installTarget, requires: e.requires ?? [], _dir: dir })
    const retired = retiredCaptures.findIndex((m) => m.id === id)
    if (retired >= 0) retiredCaptures.splice(retired, 1)
    accepted++
  }
  return { accepted, rejected }
}

// Disabled captures, kept rather than dropped.
//
// Unregistering used to delete them outright, so a disabled source vanished
// from `detectHooks()` and from capture-health together. That reads as "this
// is not happening" and it is not what disabling does: these producers run
// outside RedLog -- tcpdump under sudo, an iptables redirect, a log tailer --
// and they keep running and keep POSTing, because ingest does not consult the
// plugin registry. So an operator who pressed the switch to STOP a host-level
// redirect got a screen with no rows for it while the traffic kept landing in
// the record. A control that looks like a stop button and is actually a
// blindfold is worse than no control.
//
// They stay listed, flagged, with their live state still read from the events
// themselves — which is how "disabled, and still receiving" becomes something
// the operator can see instead of something only the record knows.
const retiredCaptures: PluginManifest[] = []

export function unregisterCapturePlugins(pluginId: string): void {
  for (let i = externalCaptures.length - 1; i >= 0; i--) {
    if (externalCaptures[i].id.startsWith(`${pluginId}.`)) {
      retiredCaptures.push(externalCaptures[i])
      externalCaptures.splice(i, 1)
    }
  }
}

/** Every capture the UI should show, live or switched off. Behaviour — install
 *  targets, hook paths — reads `allManifests()` and is deliberately unchanged:
 *  a disabled capture is listed, not runnable. */
function listableManifests(): Array<PluginManifest & { disabled?: boolean }> {
  const live = allManifests()
  const liveIds = new Set(live.map((m) => m.id))
  // WSL is a Windows feature. Listing it elsewhere shows an unusable source
  // the operator might try to install. PowerShell is not handled here: it also
  // runs on macOS and Linux, so it is a separate question.
  return [
    ...live,
    ...retiredCaptures.filter((m) => !liveIds.has(m.id)).map((m) => ({ ...m, disabled: true }))
  ].filter((m) => m.id !== 'shell-wsl' || process.platform === 'win32')
}

function allManifests(): PluginManifest[] {
  // §8-2 true removability: the starter-pack IS the built-in producers, so
  // disabling it (Settings ▸ Plugins) actually removes them — they drop out of
  // the Hooks panel and capture-health, and come back on re-enable. Note this
  // is orthogonal to the robustness fallback: a MISSING/bad manifest still
  // yields the in-code STARTER_PACK_FALLBACK (see PLUGIN_REGISTRY); only an
  // explicit DISABLE removes them. So a bad data file can never take capture
  // dark, but an operator who wants a minimal RedLog can.
  const builtins = isDisabled('starter-pack') ? [] : PLUGIN_REGISTRY
  return [...builtins, ...externalCaptures]
}

// Absolute path to a manifest's hook script source. Plugin captures resolve
// inside the plugin dir; built-ins resolve against the shipped hooks directory.
function srcPathForRelative(plugin: PluginManifest, relative: string): string {
  if (plugin._dir) return join(plugin._dir, relative)
  const hooksDir = resolveDir(HOOKS_DIR, join(__dirname, '../../hooks'))
  return join(hooksDir, relative.replace('hooks/', ''))
}

function srcPathFor(plugin: PluginManifest): string {
  return srcPathForRelative(plugin, plugin.hookFile)
}

// The exact bytes a shell-source install appends to the operator's rc, and the
// exact bytes an uninstall takes back out.
//
// FR-016: uninstall must leave the file byte-identical to what was there
// before. It did not. Install appended `\n# RedLog shell hook\nsource <dest>\n`
// and uninstall replaced that whole run — leading newline included — with a
// single `\n`, so every install/uninstall cycle left one more blank line in
// the operator's `.zshrc`, and a file that had not ended with a newline came
// back with one. A red-team tool has no business leaving a footprint on the
// machine it was run from, and "almost the same" is not a property that can be
// checked a year later.
//
// Pure, and separate from the file I/O, so the inverse property can be tested
// on any platform. `installHook` refuses outright on win32, which would
// otherwise mean this was first exercised on CI's ubuntu leg.
const hookBlock = (dest: string): string => `\n# RedLog shell hook\nsource ${dest}\n`

// The same hook, for a bash LOGIN file (.bash_profile, .bash_login, .profile).
// POSIX syntax, because `.profile` is also read by sh, dash and ksh, and by the
// `sh` a display manager runs at session start — where `source` is not a
// command and the bash adapter is not loadable. Interactive bash only, so
// `bash -lc cmd` (editors resolving the environment, CI jobs) does not start
// a recorder it never had. A login bash that ALSO reaches .bashrc's block
// sources the adapter twice; the adapter returns at once the second time
// (`_REDLOG_HOOK_LOADED_IN`, keyed on `$$`).
const loginHookBlock = (dest: string): string =>
  `\n# RedLog shell hook\nif [ -n "\${BASH_VERSION:-}" ]; then case $- in *i*) . "${dest}" ;; esac; fi\n`

// One file, several ways to write its path. An rc that says `source ~/.redlog/…`
// is the same hook as one that says `source /Users/me/.redlog/…`; checking only
// the absolute spelling made install append a second block next to a `~` one
// (the banner then printed twice) and made uninstall leave that `~` block
// behind, so a "removed" hook still loaded.
function hookSpellings(dest: string, home: string): string[] {
  const out = [dest, `"${dest}"`]
  if (home && dest.startsWith(`${home}/`)) {
    const rest = dest.slice(home.length)
    out.push(`~${rest}`, `$HOME${rest}`, `"$HOME${rest}"`, '$' + `{HOME}${rest}`)
  }
  return out
}

export function rcWithHook(content: string, dest: string, home: string = homedir(), block: (dest: string) => string = hookBlock): string {
  // Already there — by our line or by the operator's own, in any spelling of
  // the path — so nothing is added and nothing will be taken away.
  if (hookSpellings(dest, home).some((s) => content.includes(s))) return content
  return content + block(dest)
}

export function rcWithoutHook(content: string, dest: string, home: string = homedir()): string {
  // An exact string per spelling, not a pattern with optional newlines around
  // it: the optional parts are what made the removal lossy. Only a block that
  // carries our marker comment goes; a bare line the operator wrote stays.
  // The login-file block is only ever written with the absolute path.
  return hookSpellings(dest, home)
    .reduce((c, s) => c.split(hookBlock(s)).join(''), content)
    .split(loginHookBlock(dest)).join('')
}

export function getCaptureHookPath(pluginId: string): string | null {
  const plugin = allManifests().find((candidate) => candidate.id === pluginId)
  return plugin ? srcPathFor(plugin) : null
}

// For shell-source plugin captures without an explicit target, drop the hook in
// ~/.redlog under its own basename.
function installTargetFor(plugin: PluginManifest): string {
  if (plugin.installTarget) return plugin.installTarget
  const base = plugin.hookFile.split(/[\\/]/).pop() ?? `${plugin.id}.sh`
  return join(homedir(), '.redlog', base)
}

/** Resolve the complete, reviewable file set for a hook installation. The
 * adapter and every declared support file are colocated so relative sourcing
 * behaves the same in the repository and under ~/.redlog. */
export function getHookInstallPlan(pluginId: string): Array<{ source: string; target: string }> | null {
  const plugin = allManifests().find((candidate) => candidate.id === pluginId)
  if (!plugin || plugin.installMethod !== 'shell-source') return null
  const target = installTargetFor(plugin)
  return [
    { source: srcPathFor(plugin), target },
    ...(plugin.supportFiles ?? []).map((relative) => ({
      source: srcPathForRelative(plugin, relative),
      target: join(dirname(target), relative.split(/[\\/]/).pop() ?? relative)
    }))
  ]
}

// Which shell rc a shell-source hook appends to. Explicit wins; otherwise pick
// by the operator's login shell. This names the SHELL; where that shell reads
// the file from is `rcLayout`'s question.
function shellRcFor(plugin: PluginManifest): string {
  if (plugin.shellRcFile) return plugin.shellRcFile
  return process.env.SHELL?.includes('zsh') ? '.zshrc' : '.bashrc'
}

// Where each shell really reads its startup file (09-F1).
//
// Install used to write `~/.zshrc` / `~/.bashrc` and then read "installed"
// back from the same file, so a wrong guess read as success: zsh with ZDOTDIR
// reads `$ZDOTDIR/.zshrc`, and the login bash Terminal.app and iTerm2 start
// reads `.bash_profile` (or `.bash_login`, or `.profile`) and not `.bashrc`.
// Settings said installed; the shell never loaded the hook.
//
// ZDOTDIR is asked of zsh, because it is usually set in `~/.zshenv` and not in
// the app's environment. `zsh -c` is not interactive and not a login shell, so
// it reads /etc/zshenv and `.zshenv` — the files zsh itself reads to find
// ZDOTDIR — and not `.zprofile`/`.zshrc`, where prompt frameworks and
// anything that prints live. Its answer goes to a file, not a pipe, so a
// background job started from `.zshenv` cannot hold the call open. Bounded,
// asked once per home per process (`invalidateCommandCache` clears it); with
// no answer the result is `$ZDOTDIR` from this environment, else `$HOME`, and
// is marked as a guess. Not covered: ZDOTDIR changed in `.zprofile`, which
// moves `.zshrc` for login shells only.
const ZDOTDIR_PROBE_TIMEOUT_MS = 2_000
const _zdotdirProbe = new Map<string, string | null>()

function probeZdotdir(home: string): string | null {
  if (process.platform === 'win32') return null
  let work: string | undefined
  try {
    work = mkdtempSync(join(tmpdir(), 'redlog-zdotdir-'))
    const answer = join(work, 'answer')
    const r = spawnSync('zsh', ['-c', 'print -r -- "${ZDOTDIR:-$HOME}" >| "$1"', 'redlog-zdotdir', answer], {
      env: { ...process.env, HOME: home },
      stdio: 'ignore',
      timeout: ZDOTDIR_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    })
    if (r.error || r.status !== 0 || !existsSync(answer)) return null
    const dir = readFileSync(answer, 'utf8').replace(/\n$/, '')
    return dir && isAbsolute(dir) && !/[\r\n]/.test(dir) ? dir : null
  } catch {
    return null
  } finally {
    if (work) rmSync(work, { recursive: true, force: true })
  }
}

function zshRcPath(home: string): { path: string; guessed: boolean } {
  if (!_zdotdirProbe.has(home)) _zdotdirProbe.set(home, probeZdotdir(home))
  const asked = _zdotdirProbe.get(home)
  if (asked) return { path: join(asked, '.zshrc'), guessed: false }
  return { path: join(process.env.ZDOTDIR || home, '.zshrc'), guessed: true }
}

const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'] as const

/** The one file a login bash reads: the first of the three that exists. */
function bashLoginFile(home: string): string | null {
  for (const name of BASH_LOGIN_FILES) {
    const p = join(home, name)
    if (existsSync(p)) return p
  }
  return null
}

const readText = (p: string): string | null => {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : null } catch { return null }
}

/** A login file that already loads `.bashrc` reaches the hook through it.
 *  Read as text, so only the common uncommented forms count
 *  (`. ~/.bashrc`, `source "$HOME/.bashrc"`, behind `[ -f … ] &&` or an `if`).
 *  A miss is harmless: the login block is then added as well, and the second
 *  load returns at once. */
function sourcesBashrc(content: string, home: string): boolean {
  const homes = ['~', '\\$HOME', '\\$\\{HOME\\}', home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')].join('|')
  const re = new RegExp(`(^|[;&|{(\\s])(source|\\.)\\s+["']?(${homes})/\\.bashrc["']?(\\s|;|$)`)
  return content.split(/\r?\n/).some((line) => {
    const code = line.trim()
    return !code.startsWith('#') && re.test(code)
  })
}

type RcState = 'read' | 'unread' | 'absent'

interface RcLayout {
  /** Where install writes, each with the block that file gets. */
  writes: Array<{ path: string; block: (dest: string) => string }>
  /** Every file a block of ours may be in: detection and removal look here. */
  candidates: string[]
  /** Whether the shell loads a hook line found in these files. */
  state: (hookName: string) => RcState
  /** zsh did not answer and the ZDOTDIR is assumed. */
  guessed: boolean
}

function rcLayout(plugin: PluginManifest, home: string = homedir()): RcLayout {
  const rcName = shellRcFor(plugin)
  const has = (p: string | null, hookName: string): boolean => !!p && (readText(p)?.includes(hookName) ?? false)
  if (rcName === '.zshrc') {
    const { path, guessed } = zshRcPath(home)
    const candidates = [...new Set([path, join(home, '.zshrc')])]
    return {
      writes: [{ path, block: hookBlock }],
      candidates,
      state: (n) => has(path, n) ? 'read' : candidates.some((c) => has(c, n)) ? 'unread' : 'absent',
      guessed
    }
  }
  // The login-file handling leans on the built-in adapter's sourced-twice
  // guard. A plugin's own hook is not known to have one, so it gets the one
  // file it named.
  if (plugin.id === 'shell-bash' && rcName === '.bashrc') {
    const bashrc = join(home, '.bashrc')
    const login = bashLoginFile(home)
    const loginText = login ? readText(login) : null
    const writes: RcLayout['writes'] = [{ path: bashrc, block: hookBlock }]
    // No login file at all: a login bash reads nothing, so one is created,
    // holding only this block. An existing `.profile` is never shadowed by a
    // new `.bash_profile`: the block goes into the file bash already reads.
    if (!login) writes.push({ path: join(home, '.bash_profile'), block: loginHookBlock })
    else if (!sourcesBashrc(loginText ?? '', home)) writes.push({ path: login, block: loginHookBlock })
    const candidates = [bashrc, ...BASH_LOGIN_FILES.map((f) => join(home, f))]
    return {
      writes,
      candidates,
      state: (n) => {
        const nonLogin = has(bashrc, n)
        const loginReach = !!login && (has(login, n) || (nonLogin && sourcesBashrc(loginText ?? '', home)))
        if (nonLogin && loginReach) return 'read'
        return candidates.some((c) => has(c, n)) ? 'unread' : 'absent'
      },
      guessed: false
    }
  }
  const path = join(home, rcName)
  return {
    writes: [{ path, block: hookBlock }],
    candidates: [path],
    state: (n) => has(path, n) ? 'read' : 'absent',
    guessed: false
  }
}

const tildePath = (p: string, home: string = homedir()): string =>
  p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p

// Per-command lookup cache. The answer virtually never changes during a
// session; `invalidateCommandCache()` resets it after an install/uninstall so
// the next `detectHooks()` re-probes.
const _cmdCache = new Map<string, boolean>()
export function invalidateCommandCache(): void { _cmdCache.clear(); _zdotdirProbe.clear() }

// A PATH lookup, not a spawned `which` / `where`: one process per probe cost
// hundreds of milliseconds on Windows, on the main thread (command-lookup.ts).
// The name comes from a manifest's `requires[]` and is never interpreted.
function commandExists(cmd: string): boolean {
  const hit = _cmdCache.get(cmd)
  if (hit !== undefined) return hit
  const found = isOnPath(cmd)
  _cmdCache.set(cmd, found)
  return found
}

function commandExistsAsync(cmd: string): Promise<boolean> {
  return Promise.resolve(commandExists(cmd))
}

/** The command strings a `claude-settings` install writes for this plugin: the
 *  hook's path, or the relative stand-in used when the file is not on disk.
 *  Detection and removal match a settings entry by exactly one of these, and by
 *  nothing the plugin supplies. They used to match any command that merely
 *  contained a plugin-chosen string, so a matcher such as `/` made uninstall
 *  strip every hook the operator had of their own (#499). */
function claudeHookCommands(plugin: PluginManifest): string[] {
  return [srcPathFor(plugin), `redlog-hooks/${plugin.hookFile.replace('hooks/', '')}`]
}

type ClaudeHookGroup = { matcher?: unknown; hooks?: Array<{ command?: string }> }

function isClaudeSettingsInstalled(commands: string[]): boolean {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return false
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const hooks = settings?.hooks?.PostToolUse
    if (!Array.isArray(hooks)) return false
    return hooks.some((h: ClaudeHookGroup) =>
      h.hooks?.some((hk) => typeof hk.command === 'string' && commands.includes(hk.command))
    )
  } catch {
    return false
  }
}

// 'read': a file the shell loads sources the hook. 'unread': a line is there,
// but only where this shell will not load it (a `~/.zshrc` under ZDOTDIR, a
// `.bashrc` no login file reaches) — not installed, and not nothing either:
// removal still takes it out. `requireCopy: false` asks only about the lines,
// which is what removal needs: the copy may already have been deleted by hand.
function shellSourceState(plugin: PluginManifest, requireCopy = true): RcState {
  const hookPath = installTargetFor(plugin)
  if (requireCopy && !existsSync(hookPath)) return 'absent'
  return rcLayout(plugin).state(hookPath.split(/[\\/]/).pop() ?? '')
}

// PowerShell loads a different profile per edition: Windows PowerShell 5.1
// (always present on Windows) and PowerShell 7 (`pwsh`). Documents may be
// redirected (OneDrive), so the real path is asked of PowerShell itself.
type ProfilePaths = { windowsPowerShell: string; pwsh: string }

/** The conventional locations on a stock install. Kept as the fallback when
 *  the probe fails, and as the "legacy" place an earlier RedLog wrote to. */
export function powershellProfilePaths(home: string = homedir()): ProfilePaths {
  return {
    windowsPowerShell: join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    pwsh: join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
  }
}

// One probe per edition per process: detect runs often and a probe spawns a
// shell. A failed probe is cached too (as null), so a missing pwsh is not
// retried on every refresh.
const _profileProbe = new Map<string, string | null>()

/** Where each edition reads its profile: PowerShell's own answer, else the
 *  conventional path. `pwsh` is probed only when it is on PATH. */
export function resolvedPowershellProfilePaths(home: string = homedir()): ProfilePaths {
  const fallback = powershellProfilePaths(home)
  const ask = (shell: 'powershell' | 'pwsh'): string | null => {
    if (!_profileProbe.has(shell)) _profileProbe.set(shell, readProfilePath(shell))
    return _profileProbe.get(shell) ?? null
  }
  return {
    windowsPowerShell: ask('powershell') ?? fallback.windowsPowerShell,
    pwsh: (commandExists('pwsh') ? ask('pwsh') : null) ?? fallback.pwsh
  }
}

/** Every place a RedLog hook line may be: where PowerShell reads today, plus
 *  the conventional paths an earlier install used. Detect and remove look in
 *  all of them; install writes only to the resolved ones. */
function powershellProfileCandidates(home: string = homedir()): string[] {
  const all = [...Object.values(resolvedPowershellProfilePaths(home)), ...Object.values(powershellProfilePaths(home))]
  return [...new Set(all)]
}

// The line the one-click install appends. `$HOME` is resolved by PowerShell at
// load time, so the profile stays valid if the account's home moves.
const PS_PROFILE_MARKER = '# RedLog PowerShell hook'
function psProfileLine(hookName: string): string {
  return `. "$HOME\\.redlog\\${hookName}"`
}

function isPowershellProfileInstalled(hookPath: string, requireCopy = true): boolean {
  if (requireCopy && !existsSync(hookPath)) return false
  const hookName = hookPath.split(/[\\/]/).pop() ?? ''
  const needle = `.redlog\\${hookName}`
  return powershellProfileCandidates().some((profile) => {
    try { return existsSync(profile) && readFileSync(profile, 'utf-8').includes(needle) } catch { return false }
  })
}

function checkInstalled(plugin: PluginManifest): boolean {
  switch (plugin.installMethod) {
    case 'claude-settings':
      return isClaudeSettingsInstalled(claudeHookCommands(plugin))
    case 'shell-source':
      return shellSourceState(plugin) === 'read'
    case 'powershell-profile':
      return isPowershellProfileInstalled(installTargetFor(plugin))
    case 'manual':
      return false
  }
}

// An adapter whose runtime dependency is missing is not available, whatever
// its any-of `requires` say: a zsh hook without python3 installs cleanly and
// then never records a thing.
function missingRequiredAll(plugin: PluginManifest): boolean {
  return (plugin.requiresAll ?? []).some((cmd) => !commandExists(cmd))
}

function checkAvailable(plugin: PluginManifest): boolean {
  if (missingRequiredAll(plugin)) return false
  if (plugin.requires.length === 0) {
    if (plugin.id === 'shell-powershell') return process.platform === 'win32'
    if (plugin.id === 'shell-wsl') {
      if (process.platform !== 'win32') return false
      return commandExists('wsl')
    }
    if (plugin.id === 'shell-zsh') return process.env.SHELL?.includes('zsh') || existsSync('/bin/zsh')
    if (plugin.id === 'shell-bash') {
      return existsSync('/bin/bash') || (process.platform === 'win32' && commandExists('bash'))
    }
    return true
  }
  return plugin.requires.some((cmd) => commandExists(cmd))
}

async function checkAvailableAsync(plugin: PluginManifest): Promise<boolean> {
  if (missingRequiredAll(plugin)) return false
  if (plugin.requires.length === 0) {
    if (plugin.id === 'shell-powershell') return process.platform === 'win32'
    if (plugin.id === 'shell-wsl') {
      if (process.platform !== 'win32') return false
      return commandExistsAsync('wsl')
    }
    if (plugin.id === 'shell-zsh') return process.env.SHELL?.includes('zsh') || existsSync('/bin/zsh')
    if (plugin.id === 'shell-bash') {
      return existsSync('/bin/bash') || (process.platform === 'win32' && await commandExistsAsync('bash'))
    }
    return true
  }
  for (const cmd of plugin.requires) {
    if (await commandExistsAsync(cmd)) return true
  }
  return false
}

// Some hooks cannot be a one-click install — codex changes how the agent's
// shell is launched — so instead of a dead "Manual" label they hand over exact
// copy-paste commands with the absolute hook path already resolved.
//
// mitmproxy used to be the main one, with six steps: install it, put it on
// PATH, start mitmdump yourself, point your tools at it, and two for DNS.
// RedLog does the first four now — it installs mitmproxy in one click and
// starts the managed proxy when a project opens — so those steps described a
// setup nobody performs, on a panel labelled "manual" for something that is
// not. What is left is the one case the managed proxy genuinely does not
// cover.
function buildManualSteps(pluginId: string, hookFile: string, available: boolean): ManualStep[] | undefined {
  switch (pluginId) {
    case 'mitmproxy':
      return [
        // Every command below is `mitmdump …`, and on a machine without it
        // they are all "command not found" — most often on Windows, where
        // nothing brings mitmproxy in. The card said none of that: it opened
        // on step 1 of a sequence whose unstated step 0 was an install. The
        // managed proxy installs mitmproxy for the operator from the capture
        // check, so say where rather than only how.
        ...(available ? [] : [{
          label: 'This needs mitmdump, which is not on this machine. The HTTP capture '
            + 'check on the dashboard installs mitmproxy in one click; to do it yourself:',
          command: 'uv tool install mitmproxy'
        }]),
        {
          // One mitmdump serves one mode, so DNS needs a second instance
          // alongside the managed HTTP one. Nothing else in RedLog starts it.
          label: 'Optional — capture DNS as well. This is a SECOND mitmdump alongside the '
            + 'one RedLog runs: one instance serves one mode. Port 53 needs admin rights, '
            + 'so this uses 5353; point the target resolver at it.',
          command: `mitmdump -s "${hookFile}" --mode dns@5353`
        },
        {
          label: 'Then send lookups to it, e.g. to check the capture is live',
          command: process.platform === 'win32'
            ? 'nslookup -port=5353 example.com 127.0.0.1'
            : 'dig @127.0.0.1 -p 5353 example.com'
        }
      ]
    case 'shell-powershell':
      return [
        {
          label: 'Add to your PowerShell profile so it loads on every session',
          command: `Add-Content $PROFILE '. "${hookFile}"'`
        },
        {
          label: 'Or source it manually in the current session',
          command: `. "${hookFile}"`
        }
      ]
    case 'shell-wsl': {
      const wslHookPath = hookFile.replace(/\\/g, '/').replace(/^([A-Z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)
      return [
        {
          label: 'Add to your WSL ~/.bashrc so it loads on every session',
          command: `echo 'source "${wslHookPath}"' >> ~/.bashrc`
        },
        {
          label: 'Or source it manually in the current WSL session',
          command: `source "${wslHookPath}"`
        }
      ]
    }
    default:
      return undefined
  }
}

// The PowerShell profile install is one click, but its copy-paste steps stay
// as the fallback for a redirected Documents folder or a locked-down profile.
function hasManualSteps(plugin: PluginManifest): boolean {
  return plugin.installMethod === 'manual' || plugin.installMethod === 'powershell-profile'
}

export function detectHooks(): PluginInfo[] {
  const builtinIds = new Set(PLUGIN_REGISTRY.map((p) => p.id))
  return listableManifests().map((plugin) => {
    const hookFile = srcPathFor(plugin)
    const available = checkAvailable(plugin)
    const manualSteps = hasManualSteps(plugin)
      ? (plugin.manualSteps ?? buildManualSteps(plugin.id, hookFile, available))
      : undefined

    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      agentType: plugin.agentType,
      emits: plugin.emits,
      platforms: plugin.platforms,
      installed: checkInstalled(plugin),
      available,
      installMethod: plugin.installMethod,
      hookFile,
      manualSteps,
      removalSteps: buildRemovalSteps(plugin.id, undefined, hookFile),
      builtin: builtinIds.has(plugin.id),
      /** Switched off in Settings ▸ 外掛. Still listed, because the producer
       *  runs outside RedLog and disabling does not stop it. */
      disabled: (plugin as { disabled?: boolean }).disabled === true,
      stepsAreOptional: plugin.id === 'mitmproxy'
    }
  })
}

let _detectCache: PluginInfo[] | null = null

export async function detectHooksAsync(): Promise<PluginInfo[]> {
  const manifests = listableManifests()
  const builtinIds = new Set(PLUGIN_REGISTRY.map((p) => p.id))
  const results = await Promise.all(manifests.map(async (plugin) => {
    const hookFile = srcPathFor(plugin)
    const available = await checkAvailableAsync(plugin)
    const manualSteps = hasManualSteps(plugin)
      ? (plugin.manualSteps ?? buildManualSteps(plugin.id, hookFile, available))
      : undefined
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      agentType: plugin.agentType,
      emits: plugin.emits,
      platforms: plugin.platforms,
      installed: checkInstalled(plugin),
      available,
      installMethod: plugin.installMethod,
      hookFile,
      manualSteps,
      removalSteps: buildRemovalSteps(plugin.id, undefined, hookFile),
      builtin: builtinIds.has(plugin.id),
      /** Switched off in Settings ▸ 外掛. Still listed, because the producer
       *  runs outside RedLog and disabling does not stop it. */
      disabled: (plugin as { disabled?: boolean }).disabled === true,
      stepsAreOptional: plugin.id === 'mitmproxy'
    }
  }))
  _detectCache = results
  return results
}

export function getCachedHooks(): PluginInfo[] | null {
  return _detectCache
}

export function invalidateHooksCache(): void {
  _detectCache = null
}

/** Bring every enrolled shell's ~/.redlog copy up to the hook this app ships.
 *  The copy is written once at install and sourced from there, so without this
 *  an upgrade left the shell on the old hook while Settings said "installed".
 *  Only copies an rc or profile already sources are touched; nothing is
 *  enrolled here. Returns the ids whose files were rewritten. */
export function refreshInstalledHooks(): string[] {
  const refreshed: string[] = []
  for (const plugin of allManifests()) {
    const files = plugin.installMethod === 'shell-source' ? getHookInstallPlan(plugin.id)
      : plugin.installMethod === 'powershell-profile' ? [{ source: srcPathFor(plugin), target: installTargetFor(plugin) }]
      : null
    // A shell-source copy that any rc names is in use, whether or not that rc
    // is one the shell reads today: an out-of-date copy is wrong either way.
    const enrolled = plugin.installMethod === 'shell-source'
      ? shellSourceState(plugin) !== 'absent'
      : checkInstalled(plugin)
    if (!files || !enrolled) continue
    let changed = false
    for (const file of files) {
      try {
        if (!existsSync(file.source)) continue
        const want = readFileSync(file.source)
        if (existsSync(file.target) && readFileSync(file.target).equals(want)) continue
        writeFileSync(file.target, want)
        changed = true
      } catch (e) {
        console.warn(`[hooks] could not refresh ${file.target}: ${(e as Error).message}`)
      }
    }
    if (changed) refreshed.push(plugin.id)
  }
  return refreshed
}

/** What the uninstaller's `--remove-hooks` run does on this side: take every
 *  enrolment out of the rc or profile that holds it. The uninstaller keeps
 *  ~/.redlog, so without this a PowerShell profile went on dot-sourcing the
 *  hook copy there for an app that was gone. Returns the ids removed. */
export function removeInstalledHooks(): string[] {
  const removed: string[] = []
  for (const plugin of allManifests()) {
    // The line is what has to go, so ask whether it is there — not whether
    // the copy it names still is (the operator may have cleared ~/.redlog).
    const sourced = plugin.installMethod === 'shell-source'
      ? shellSourceState(plugin, false) !== 'absent'
      : plugin.installMethod === 'powershell-profile'
        ? isPowershellProfileInstalled(installTargetFor(plugin), false)
        : false
    if (sourced && uninstallHook(plugin.id).success) removed.push(plugin.id)
  }
  return removed
}

export function installHook(pluginId: string): { success: boolean; message: string } {
  const plugin = allManifests().find((p) => p.id === pluginId)
  if (!plugin) return { success: false, message: `Unknown plugin: ${pluginId}` }

  switch (plugin.installMethod) {
    case 'claude-settings': {
      const hookFile = srcPathFor(plugin)
      const settingsPath = join(homedir(), '.claude', 'settings.json')
      try {
        mkdirSync(join(homedir(), '.claude'), { recursive: true })
        let settings: Record<string, unknown> = {}
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        }
        if (!settings.hooks) settings.hooks = {}
        const hooks = settings.hooks as Record<string, unknown>
        if (!hooks.PostToolUse) hooks.PostToolUse = []
        const postTool = hooks.PostToolUse as Array<Record<string, unknown>>
        const commands = claudeHookCommands(plugin)
        const exists = postTool.some((h) =>
          (h.hooks as Array<{ command?: string }>)?.some((hk) => typeof hk.command === 'string' && commands.includes(hk.command))
        )
        if (!exists) {
          postTool.push({
            matcher: 'Bash',
            hooks: [{ command: existsSync(hookFile) ? hookFile : `redlog-hooks/${plugin.hookFile.replace('hooks/', '')}` }]
          })
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
        return { success: true, message: `${plugin.name} hook added to ~/.claude/settings.json` }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-source': {
      // Refuse on Windows — appending `source <path>` to a fabricated
      // %USERPROFILE%\.bashrc silently corrupts profiles when the user
      // isn't running Git Bash. PowerShell setup is a manual `$PROFILE`
      // paste per docs/windows-setup.md. Audit P0-3.
      if (process.platform === 'win32') {
        return {
          success: false,
          message: `${plugin.name}: shell-source install is not supported on Windows. See docs/windows-setup.md for the PowerShell $PROFILE setup.`
        }
      }
      try {
        const plan = getHookInstallPlan(plugin.id)
        if (!plan || plan.length === 0) throw new Error('Empty hook install plan')
        const dest = plan[0].target
        mkdirSync(join(homedir(), '.redlog'), { recursive: true })
        for (const file of plan) {
          if (!existsSync(file.source)) throw new Error(`Missing hook file: ${file.source}`)
          copyFileSync(file.source, file.target)
        }
        const layout = rcLayout(plugin)
        for (const { path, block } of layout.writes) {
          const before = existsSync(path) ? readFileSync(path, 'utf-8') : ''
          const after = rcWithHook(before, dest, homedir(), block)
          if (after !== before) writeFileSync(path, after)
        }
        const files = layout.writes.map((w) => tildePath(w.path))
        return {
          success: true,
          message: `${plugin.name} hook added to ${files.join(' and ')}. Open a new terminal, or run: source ${files[0]}`
            + (layout.guessed ? ' (zsh did not say where it reads .zshrc, so this is assumed)' : '')
        }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'powershell-profile': {
      // Mirrors shell/install.ps1: copy the hook under ~/.redlog, then append
      // the dot-source line to the profile(s) — idempotently.
      if (process.platform !== 'win32') {
        return { success: false, message: `${plugin.name}: one-click install is only supported on Windows.` }
      }
      const dest = installTargetFor(plugin)
      try {
        const src = srcPathFor(plugin)
        if (!existsSync(src)) throw new Error(`Missing hook file: ${src}`)
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(src, dest)
        const hookName = dest.split(/[\\/]/).pop()!
        const line = psProfileLine(hookName)
        const profiles = resolvedPowershellProfilePaths()
        const targets = [profiles.windowsPowerShell, ...(commandExists('pwsh') ? [profiles.pwsh] : [])]
        for (const profile of targets) {
          mkdirSync(dirname(profile), { recursive: true })
          const content = existsSync(profile) ? readFileSync(profile, 'utf-8') : ''
          if (content.includes(`.redlog\\${hookName}`)) continue
          const sep = content.length === 0 || content.endsWith('\n') ? '' : '\r\n'
          writeFileSync(profile, `${content}${sep}${PS_PROFILE_MARKER}\r\n${line}\r\n`)
        }
        return { success: true, message: `${plugin.name} hook installed. Open a new PowerShell window, or run: . $PROFILE` }
      } catch (e) {
        return {
          success: false,
          message: `Failed: ${e}. Manual fallback: add  . "${dest}"  to your PowerShell $PROFILE.`
        }
      }
    }
    case 'manual':
      return { success: false, message: `Manual setup required for ${plugin.name}` }
  }
}

/** `steps` is present when RedLog cannot do the removal itself: the operator
 *  needs to know what to undo, not just that it is their job. */
export function uninstallHook(pluginId: string): { success: boolean; message: string; steps?: ManualStep[] } {
  const plugin = allManifests().find((p) => p.id === pluginId)
  if (!plugin) return { success: false, message: `Unknown plugin: ${pluginId}` }

  switch (plugin.installMethod) {
    case 'claude-settings': {
      const settingsPath = join(homedir(), '.claude', 'settings.json')
      try {
        if (!existsSync(settingsPath)) return { success: true, message: 'Already removed' }
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        const postTool = settings?.hooks?.PostToolUse as Array<Record<string, unknown>> | undefined
        const commands = claudeHookCommands(plugin)
        if (postTool) {
          // Take out the hook RedLog wrote and nothing beside it: a group the
          // operator shares with it keeps their own hooks.
          settings.hooks.PostToolUse = postTool.flatMap((h) => {
            const own = h.hooks as Array<{ command?: string }> | undefined
            if (!Array.isArray(own)) return [h]
            const kept = own.filter((hk) => !(typeof hk.command === 'string' && commands.includes(hk.command)))
            if (kept.length === own.length) return [h]
            return kept.length > 0 ? [{ ...h, hooks: kept }] : []
          })
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
        return { success: true, message: `${plugin.name} hook removed` }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-source': {
      try {
        const dest = installTargetFor(plugin)
        // Every file a block may be in — where the shell reads today, and the
        // `~/.zshrc` or login file an earlier install wrote to.
        for (const rcPath of rcLayout(plugin).candidates) {
          if (!existsSync(rcPath)) continue
          const before = readFileSync(rcPath, 'utf-8')
          const after = rcWithoutHook(before, dest)
          if (after !== before) {
            // An rc that holds nothing but our block was created by the
            // install. Leaving a 0-byte file behind is a footprint, the same
            // one the PowerShell branch below already refuses to leave.
            if (after === '') rmSync(rcPath, { force: true })
            else writeFileSync(rcPath, after)
          }
        }
        // The rc edit only reaches shells started from now on. Terminals that
        // are already open have the hook loaded; stop them too, or "removed"
        // would be said while they keep recording.
        const shell = /zsh/i.test(plugin.id) ? 'zsh' : /bash/i.test(plugin.id) ? 'bash' : null
        const { stopped } = shell ? stopOpenTerminals(shell) : { stopped: 0 }
        return {
          success: true,
          message: `${plugin.name} hook removed. New terminals will not record.` +
            (stopped > 0 ? ` ${stopped} open terminal${stopped === 1 ? '' : 's'} stopped recording (redlog start resumes one).` : '') +
            // The bash adapter keeps no per-terminal state, so there is nothing
            // to stop from outside: say so rather than imply it is handled.
            (shell === 'bash' ? ' Bash terminals that are already open keep recording until you close them.' : '')
        }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'powershell-profile': {
      try {
        const hookName = installTargetFor(plugin).split(/[\\/]/).pop()!
        const needle = `.redlog\\${hookName}`
        for (const profile of powershellProfileCandidates()) {
          if (!existsSync(profile)) continue
          const lines = readFileSync(profile, 'utf-8').split(/\r?\n/)
          const kept = lines.filter((l) => !l.includes(needle) && l.trim() !== PS_PROFILE_MARKER)
          if (kept.length === lines.length) continue
          // Install and uninstall must be inverses. Where the operator had no
          // profile, install created one holding nothing but our two lines —
          // removing those left a 0-byte file, and its directory, behind. That
          // is a footprint on the operator's machine, which is exactly the
          // thing a red-team tool has no business leaving.
          //
          // A profile with any content of its own keeps the existing
          // behaviour: take out our two lines, leave the rest untouched.
          if (kept.every((l) => l.trim() === '')) {
            rmSync(profile, { force: true })
            // And the directory, when install is what created it. `rmdir`
            // refuses a non-empty directory, which is exactly the check.
            try { rmdirSync(dirname(profile)) } catch { /* not ours, or not empty */ }
            continue
          }
          writeFileSync(profile, kept.join('\r\n'))
        }
        return { success: true, message: `${plugin.name} hook removed. Open a new PowerShell window.` }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'manual': {
      const steps = buildRemovalSteps(plugin.id)
      return {
        success: false,
        message: steps
          ? `${plugin.name} must be removed by hand — the steps are on its card.`
          : `Manual removal required for ${plugin.name}`,
        steps
      }
    }
  }
}
