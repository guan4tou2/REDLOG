import { spawn, ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import os from 'os'
import type { BrowserConfig } from '../../core/browser-defaults'

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

// Chrome's own background traffic, kept out of the engagement record.
//
// Measured on a FRESH isolated profile, browser launched and then left alone
// for 25 seconds with nothing navigated to: 47 `scanner.http_request_start`
// rows (optimizationguide-pa.googleapis.com model downloads, gstatic,
// clients2.google.com), an 11 MB `http-body-index.db`, and — worst — three
// chained `credential_use` rows tagged MITRE T1078 (Valid Accounts) for
// Chrome's GCM registration against android.clients.google.com. None of that
// is the operator, and all of it ships to the client inside events.jsonl.
//
// This profile is RedLog's own, so the fix belongs here rather than in a
// filter downstream: traffic never generated needs no classifying. Only
// applied with `isolateProfile`, because an operator pointed at their own
// profile has chosen their own browser's behaviour and we do not override it.
const QUIET_ARGS = [
  // The umbrella switch: variations seed, field trials, GCM/push
  // registration, the safe-browsing and component update fetches.
  '--disable-background-networking',
  // Not covered by the umbrella on every channel, so named too.
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-features=OptimizationHints,OptimizationGuideModelDownloading,MediaRouter,Translate,'
    + 'NetworkTimeServiceQuerying,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
  // Chrome's own bundled component extensions are what register for GCM
  // (android.clients.google.com/c2dm) and poll the update service. This does
  // NOT touch extensions the operator installs — those are often the point of
  // using a real browser on an engagement.
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--no-pings',
  // Chrome's first-run and promo fetches.
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--metrics-recording-only',
  '--disable-search-engine-choice-screen'
]

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
    args.push(...QUIET_ARGS)
  }
  if (cfg.ignoreCertErrors) args.push('--ignore-certificate-errors')
  args.push(...cfg.extraArgs.filter(Boolean))
  // With no start URL Chrome opens its New Tab Page, which is a real page
  // load against google.com — the promos, the OneGoogle bar, the doodle, the
  // logo from gstatic, the omnibox suggestion prefetch. Through the capture
  // proxy that is ~40 requests of the operator's browser fetching Google's
  // homepage furniture, recorded as engagement traffic before the operator
  // has typed anything. `about:blank` is the honest starting point for a
  // browser whose whole purpose is to be pointed at a target. Only applied
  // for RedLog's own profile, and any startUrl the operator sets still wins.
  args.push(cfg.startUrl || (cfg.isolateProfile ? 'about:blank' : ''))
  return args.filter(Boolean)
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
