import { desktopCapturer, screen } from 'electron'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { ingestEvent } from '../../core/ingest'
import { eventBus } from '../../core/event-bus'
import { noteCaptureError, clearCaptureError, type CapturePrerequisite } from '../../core/capture-health'
import { currentScreenRecording } from './capture-prerequisites'
import { getProjectDir, dbGeneration } from '../../core/db/index'
import type { ProjectIdentity } from '../../core/project-runtime'

// Triggers that represent someone asking for this exact frame, as opposed to
// the agent deciding to take one. See captureNow.
const DELIBERATE_TRIGGERS = new Set(['manual', 'api'])

/** How long a frame held at the moment of a shortcut stays usable. */
const HELD_FRAME_TTL_MS = 120_000

interface Frame {
  image: Electron.NativeImage
  jpeg: Buffer
  width: number
  height: number
  displayId: string | null
  /** when the pixels were taken, which for a held frame is before the event */
  at: number
}

/** Hides RedLog's own windows; resolves to the function that brings them back. */
export type WindowHider = () => Promise<() => void>

export interface CaptureOptions {
  /** Use the frame held when the marker shortcut fired, if this is its token. */
  heldFrame?: string
  /** Take RedLog's windows (main and HUD) off the screen for the capture. */
  hideOwnWindows?: boolean
  /** The operator's selected target, passed by the in-app capture. Used for a
   *  `manual` capture only: an `api` capture has no operator selection behind
   *  it and records none. */
  targetId?: string
}

export class ScreenshotAgent {
  private lastHash = ''
  // Held by reference and read when an event is written: the operator can be
  // changed in Settings while the project stays open.
  private identity: Readonly<ProjectIdentity> | null = null
  private quality = 85
  // UI/UX audit F2. A capture asked for from inside RedLog photographed
  // RedLog: ⌘⇧M raised the main window before the marker's screenshot, and
  // "Capture now" ran with the app in front. The frame the operator meant was
  // the one behind it. So the shortcut holds a frame before anything is
  // raised, and in-app captures hide RedLog's windows for the moment of the
  // grab. A held frame is never written unless a marker claims it.
  private held: { token: string; frame: Frame } | null = null
  private hider: WindowHider | null = null

  constructor(private readonly screenAccess: () => CapturePrerequisite = currentScreenRecording) {}

  setWindowHider(hider: WindowHider | null): void { this.hider = hider }

  /** Grab the current screen now, keep it in memory only, and return a token a
   *  later capture can claim it with. Null when nothing could be grabbed. */
  async holdFrame(): Promise<string | null> {
    if (!this.identity?.operatorId) return null
    const frame = await this.grabFrame().catch((e) => { noteCaptureError('screenshot', e); return null })
    if (!frame) { this.held = null; return null }
    const token = crypto.randomBytes(8).toString('hex')
    this.held = { token, frame }
    return token
  }

  private takeHeld(token: string | undefined): Frame | null {
    const h = this.held
    if (!token || !h || h.token !== token) return null
    this.held = null
    return Date.now() - h.frame.at <= HELD_FRAME_TTL_MS ? h.frame : null
  }

  /** One frame of the display the operator is working on — the one under the
   *  cursor — rather than always the primary display. */
  private async grabFrame(): Promise<Frame | null> {
    // Without Screen Recording permission macOS still hands back a frame: the
    // wallpaper, with every window missing. It is not a picture of the screen
    // and must not be stored as one (#688).
    if (this.screenAccess().state === 'missing') {
      noteCaptureError('screenshot', new Error('Screen Recording permission is not granted; nothing was recorded'))
      return null
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { width, height } = display.size
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    })
    // An empty source list is a failure, not "nothing to capture".
    //
    // There is always a screen; `getSources` returning none means the
    // capture backend could not enumerate it. Observed on Windows 11 /
    // Chromium 152 in a single-display session — `types: ['screen']` came
    // back empty while `types: ['window']` returned six. Whatever the
    // upstream cause, the effect here was that every periodic capture
    // silently did nothing: no event, no error, and capture-health still
    // reading `state: "idle"`, which is what it says before the first
    // screenshot of a fresh project. "Not yet" and "never again" looked
    // identical, so an operator relying on periodic screenshots would find
    // out at write-up time.
    if (!sources.length) {
      noteCaptureError('screenshot', new Error(
        `desktopCapturer returned no screen sources (${screen.getAllDisplays().length} display(s) known)`
      ))
      return null
    }
    const source = sources.find((src) => src.display_id === String(display.id)) ?? sources[0]
    const image = source.thumbnail
    const jpeg = image.toJPEG(this.quality)
    // An empty frame is a FAILURE, and it must never become evidence.
    //
    // Windows 11 / Chromium 152 hands back the right number of screen
    // sources with every thumbnail empty: `getSize()` 0x0, `isEmpty()`
    // true, `toJPEG()` 0 bytes, at every `thumbnailSize` we asked for
    // (window sources on the same box are fine). Nothing below this point
    // notices — the sha256 of zero bytes is a perfectly good hash — so a
    // deliberate capture wrote a 0-byte .jpg, ingested a screenshot event
    // for it, showed it in the Screenshots grid as a captured frame, and
    // exported it into the evidence bundle, where the verifier confirmed
    // its sha256 and reported the file verified. A bundle that certifies a
    // blank screenshot as a screenshot is worse than one with no screenshot
    // in it: it is a claim about the engagement that is not true.
    if (jpeg.length === 0 || image.isEmpty()) {
      const { width: tw, height: th } = image.getSize()
      noteCaptureError('screenshot', new Error(
        `screen capture came back empty (${sources.length} source(s), thumbnail ${tw}x${th}, ` +
        `${screen.getAllDisplays().length} display(s)) — nothing was recorded`
      ))
      return null
    }
    return { image, jpeg, width, height, displayId: source.display_id || null, at: Date.now() }
  }

  /** Ruling 7 (2026-11-12): screenshots are taken when someone asks — the
   *  operator (manual, a marker) or their agent (POST /api/screenshot). There
   *  is no timer and no capture when a command ends; an old project file's
   *  `intervalSec` / `captureOnCommand` / `diffThreshold` are not passed in. */
  configure(opts: {
    identity?: Readonly<ProjectIdentity>
    quality?: number
  }): void {
    if (opts.identity) this.identity = opts.identity
    if (opts.quality) this.quality = opts.quality
  }

  /** The project is closing: a frame held for a marker in it is not to be
   *  claimed by the next one. */
  stop(): void { this.held = null }

  async captureNow(trigger: string, causeEventId?: string, opts: CaptureOptions = {}): Promise<string | null> {
    const identity = this.identity
    if (!identity?.operatorId) return null
    // Deliberate captures always land — operator intent overrides pause and
    // dedup. `api` belongs here with `manual`: POST /api/screenshot is an
    // operator (or their agent) asking for THIS frame, so silently skipping it
    // because the screen looks like the last one, or because recording is
    // paused, loses a frame someone asked for and says `captured: false` with
    // no reason. Any other trigger is ambient and stays deduped (none is
    // started today: ruling 7 removed the periodic and command triggers).
    const deliberate = DELIBERATE_TRIGGERS.has(trigger)
    if (!deliberate && eventBus.paused) return null
    // The grab and the write each wait. A project switched in between would
    // get a frame the operator took in the previous one, linked by
    // `_causes` to an event that is not in it — or an event pointing at a
    // file in the previous project's folder.
    const opened = dbGeneration()
    try {
      let frame = deliberate ? this.takeHeld(opts.heldFrame) : null
      const heldAt = frame ? frame.at : null
      if (!frame) {
        const restore = deliberate && opts.hideOwnWindows && this.hider ? await this.hider() : null
        try {
          frame = await this.grabFrame()
        } finally {
          restore?.()
        }
      }
      if (!frame || dbGeneration() !== opened) return null
      const { jpeg, width, height } = frame
      const sha256 = crypto.createHash('sha256').update(jpeg).digest('hex')
      const dedupKey = sha256.slice(0, 16)

      if (!deliberate) {
        // An exact repeat of the last frame is not stored again. Deliberate
        // captures always land.
        if (dedupKey === this.lastHash) return null
      }
      this.lastHash = dedupKey

      const dir = path.join(getProjectDir(), 'screenshots')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      // The name carries milliseconds, which is not enough: two deliberate
      // captures inside the same millisecond produced the same name and the
      // second silently overwrote the first. A burst - the operator hitting
      // the shortcut twice, or an agent posting to /api/screenshot in a loop -
      // lost frames while every call reported success and every event pointed
      // at a file that by then held a different picture.
      let filename = `${ts}_${trigger}.jpg`
      let filepath = path.join(dir, filename)
      for (let n = 2; fs.existsSync(filepath); n++) {
        filename = `${ts}_${trigger}-${n}.jpg`
        filepath = path.join(dir, filename)
      }
      // v0.6.97 D: 4K JPEGs at quality=80 land 800KB-1.5MB — writeFileSync
      // blocks the main thread for 5-15ms per shot (measured on APFS SSD).
      // With the 10s periodic timer that's not visible, but a burst (idle
      // trigger + marker + manual back-to-back) stacks into a jank spike.
      // fs.promises.writeFile off-loads the syscall to libuv's thread pool.
      await fs.promises.writeFile(filepath, jpeg)
      if (dbGeneration() !== opened) {
        await fs.promises.rm(filepath, { force: true }).catch(() => {})
        return null
      }

      let evt: ReturnType<typeof ingestEvent> = null
      try { evt = ingestEvent('screenshot', {
        trigger,
        filePath: filepath,
        filename,
        size: jpeg.length,
        width,
        height,
        sha256,
        hash: dedupKey,
        ...(frame.displayId ? { display_id: frame.displayId } : {}),
        // A frame held at the shortcut predates this event; say when it was taken.
        ...(heldAt ? { captured_at: heldAt, held_for_marker: true } : {}),
        // v0.6.89 `_causes`: EventMarker (⌘⇧M) passes the marker event id so
        // focus chain walks link marker→screenshot→(later screenshot_deleted).
        ...(causeEventId ? { _causes: [causeEventId] } : {})
        // v0.9.5: the pause gate now lives in insertEvent, so the local
        // ambient-vs-manual check above needs to carry through to it —
        // otherwise a manual capture while paused writes the JPEG to disk and
        // then silently drops its event row, leaving an orphan file.
      }, {
        engagementId: identity.engagementId,
        operatorId: identity.operatorId,
        bypassPause: deliberate,
        ...(trigger === 'manual' && opts.targetId ? { targetId: opts.targetId, targetVia: 'operator-selected' as const } : {})
      }) } catch (e) {
        // The picture is on disk but no event points at it: a file nothing in
        // the project accounts for. Remove it rather than leave one behind.
        await fs.promises.rm(filepath, { force: true }).catch(() => {})
        throw e
      }
      if (!evt) {
        // Same orphan, and the caller must not be told a screenshot was saved.
        await fs.promises.rm(filepath, { force: true }).catch(() => {})
        noteCaptureError('screenshot', new Error('The screenshot was captured but its event was not recorded'))
        return null
      }
      clearCaptureError('screenshot')
      return filepath
    } catch (e) {
      // Screenshot capture failure — forward to capture-health so a persistent
      // failure (permission denied / disk full / display asleep) surfaces on
      // StatusBar rather than silently swallowing (v0.6.86). It marks THIS
      // source `error`; it is not a `noteDbError`, which means evidence cannot
      // be written at all and takes the whole verdict dark.
      noteCaptureError('screenshot', e)
      return null
    }
  }
}
