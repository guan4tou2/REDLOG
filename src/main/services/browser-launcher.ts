import { spawn, ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import os from 'os'

export interface BrowserConfig {
  binary: string        // '' = auto-detect
  proxy: string         // e.g. http://127.0.0.1:8080 — '' disables the flag
  cdpPort: number       // remote debugging port, so QuickMarks can read the tab
  isolateProfile: boolean
  ignoreCertErrors: boolean
  startUrl: string
  extraArgs: string[]
}

export const DEFAULT_BROWSER: BrowserConfig = {
  binary: '',
  proxy: 'http://127.0.0.1:8080',
  cdpPort: 9222,
  isolateProfile: true,
  ignoreCertErrors: true,
  startUrl: '',
  extraArgs: []
}

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
]

// Per-user Chrome installs (`Chrome for me only`) land under
// %LOCALAPPDATA%\Google\Chrome\Application\ and are the default when a
// non-admin runs the installer. Missing them meant every non-admin Chrome
// user saw "No Chromium-based browser found". Audit P2-5.
const WIN_LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? ''
const WIN_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ...(WIN_LOCAL_APP_DATA ? [
    `${WIN_LOCAL_APP_DATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${WIN_LOCAL_APP_DATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${WIN_LOCAL_APP_DATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
  ] : [])
]

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge'
]

export function detectBrowser(): string | null {
  const candidates =
    os.platform() === 'darwin' ? MAC_CANDIDATES :
    os.platform() === 'win32' ? WIN_CANDIDATES :
    LINUX_CANDIDATES
  return candidates.find((p) => existsSync(p)) ?? null
}

export function buildArgs(cfg: BrowserConfig, profileDir: string): string[] {
  const args: string[] = []
  if (cfg.proxy) {
    args.push(`--proxy-server=${cfg.proxy}`)
    // Chrome otherwise bypasses the proxy for localhost, which hides exactly
    // the traffic an operator testing a local target wants captured.
    args.push('--proxy-bypass-list=<-loopback>')
  }
  if (cfg.cdpPort > 0) args.push(`--remote-debugging-port=${cfg.cdpPort}`)
  if (cfg.isolateProfile) {
    args.push(`--user-data-dir=${profileDir}`)
    args.push('--no-first-run', '--no-default-browser-check')
  }
  if (cfg.ignoreCertErrors) args.push('--ignore-certificate-errors')
  args.push(...cfg.extraArgs.filter(Boolean))
  if (cfg.startUrl) args.push(cfg.startUrl)
  return args
}

let child: ChildProcess | null = null

export interface LaunchResult {
  ok: boolean
  pid?: number
  binary?: string
  args?: string[]
  profileDir?: string
  error?: string
}

export function isBrowserRunning(): boolean {
  return !!child && child.exitCode === null && !child.killed
}

export function launchBrowser(cfg: BrowserConfig, projectDir: string): LaunchResult {
  if (isBrowserRunning()) {
    return { ok: false, error: 'A RedLog browser is already running', pid: child?.pid }
  }

  const binary = cfg.binary || detectBrowser()
  if (!binary) {
    return { ok: false, error: 'No Chromium-based browser found. Set the binary path in Settings ▸ Data.' }
  }
  if (!existsSync(binary)) {
    return { ok: false, error: `Browser binary not found: ${binary}` }
  }

  const profileDir = path.join(projectDir, 'browser-profile')
  if (cfg.isolateProfile) mkdirSync(profileDir, { recursive: true })

  const args = buildArgs(cfg, profileDir)

  try {
    child = spawn(binary, args, { detached: true, stdio: 'ignore' })
    child.unref()
    child.on('exit', () => { child = null })
    return { ok: true, pid: child.pid, binary, args, profileDir }
  } catch (e) {
    child = null
    return { ok: false, error: (e as Error).message }
  }
}

export function stopBrowser(): boolean {
  if (!isBrowserRunning()) return false
  try { child!.kill() } catch { /* already gone */ }
  child = null
  return true
}
