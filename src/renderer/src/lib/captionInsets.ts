// The space the OS draws its minimise / maximise / close buttons in.
//
// On Windows and Linux the main window is created with `titleBarOverlay`
// (src/main/windows.ts): the OS buttons sit in a strip at the top-right, ON TOP
// of the page. Anything the page puts there is covered. Chromium reports where
// the strip is through `navigator.windowControlsOverlay` (`visible`,
// `getTitlebarAreaRect()`, a `geometrychange` event) — the same numbers as the
// `env(titlebar-area-*)` CSS variables, in CSS pixels of the window.
//
// The page is drawn at `body { zoom }` (lib/uiScale), so a length written in
// the page is multiplied by the zoom on screen: the strip's 138 px must be
// divided by the zoom to be 138 px of screen. That division happens here, once,
// and the result is published as three custom properties on the root:
//
//   --wco-inset-right  how far the OS buttons reach in from the right edge
//   --wco-height       how far down the strip reaches
//   --wco-inset-left   how far the macOS traffic lights reach in from the left
//
// Components never ask which platform it is: they use the `pr-caption`,
// `mr-caption`, `pt-caption` and `pl-caption` utilities (styles/index.css),
// which read them. On macOS the right inset and height are 0px and the left
// inset is the traffic lights; elsewhere the left inset is 0px.

import { BASE_ZOOM } from './uiScale'

export interface OverlayRect { x: number; y: number; width: number; height: number }

export interface CaptionInsets {
  /** From the left edge, in page pixels: the macOS traffic lights. */
  left: number
  /** From the right edge, in page pixels (already divided by the zoom). */
  right: number
  /** From the top edge, in page pixels. */
  height: number
}

export interface OverlayReading {
  visible: boolean
  rect: OverlayRect
}

/** Used while an overlay is expected but the API has said nothing yet, so the
 *  first paint cannot put a control under the buttons. Screen pixels. Windows'
 *  three buttons are 138; the rest is margin for Linux and for a themed width. */
export const FALLBACK_RIGHT_PX = 150
/** The height `titleBarOverlay` is created with in windows.ts. */
export const FALLBACK_HEIGHT_PX = 40

/** Right edge of the macOS traffic lights, screen pixels. Measured on macOS 27
 *  with `titleBarStyle: 'hiddenInset'` at the default button position. */
export const MAC_LIGHTS_REACH_PX = 72
/** Gap kept between the lights and the first control, screen pixels. */
export const MAC_LIGHTS_GAP_PX = 12

export const NO_INSET: CaptionInsets = { left: 0, right: 0, height: 0 }

function validZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : BASE_ZOOM
}

/** Pure: an overlay reading, the window width and the body zoom to the two
 *  reservations. `reading` is null when the API is absent. `settled` is true
 *  once the API has reported at least once; an overlay that is "not visible"
 *  before that is more likely not measured yet than not drawn. */
export function captionInsets(input: {
  isMac: boolean
  reading: OverlayReading | null
  settled: boolean
  viewportWidth: number
  zoom: number
}): CaptionInsets {
  const zoom = validZoom(input.zoom)
  if (input.isMac) return { ...NO_INSET, left: round((MAC_LIGHTS_REACH_PX + MAC_LIGHTS_GAP_PX) / zoom) }
  const { reading } = input
  if (reading?.visible) {
    const { x, y, width, height } = reading.rect
    const right = Math.max(0, input.viewportWidth - (x + width))
    return { left: 0, right: round(right / zoom), height: round(Math.max(0, y + height) / zoom) }
  }
  if (reading && input.settled) return NO_INSET // reported, and nothing is drawn (full screen)
  return { left: 0, right: round(FALLBACK_RIGHT_PX / zoom), height: round(FALLBACK_HEIGHT_PX / zoom) }
}

function round(n: number): number { return Math.round(n * 100) / 100 }

interface WindowControlsOverlayLike extends EventTarget {
  visible: boolean
  getTitlebarAreaRect: () => OverlayRect
}

function overlayApi(): WindowControlsOverlayLike | null {
  const api = (navigator as { windowControlsOverlay?: WindowControlsOverlayLike }).windowControlsOverlay
  return api ?? null
}

function bodyZoom(): number {
  try {
    // What main.tsx and Settings write; the stylesheet's default applies only
    // when neither has, and then the computed value is the answer.
    const v = parseFloat(document.body.style.getPropertyValue('--app-zoom'))
    if (Number.isFinite(v) && v > 0) return v
    const z = parseFloat(getComputedStyle(document.body).zoom)
    if (Number.isFinite(z) && z > 0) return z
  } catch { /* no layout engine: the default zoom */ }
  return BASE_ZOOM
}

/** Publish the three properties now and keep them current: the overlay moving
 *  (`geometrychange`: resize, maximise, OS scale), the window resizing, and the
 *  body zoom changing (Settings sets `--app-zoom`). Returns the cleanup. */
export function installCaptionInsets(isMac: boolean): () => void {
  const root = document.documentElement
  const api = overlayApi()
  let settled = false
  const publish = (): void => {
    const reading = api ? { visible: api.visible, rect: api.getTitlebarAreaRect() } : null
    const { left, right, height } = captionInsets({ isMac, reading, settled, viewportWidth: window.innerWidth, zoom: bodyZoom() })
    root.style.setProperty('--wco-inset-right', `${right}px`)
    root.style.setProperty('--wco-height', `${height}px`)
    root.style.setProperty('--wco-inset-left', `${left}px`)
  }
  const onGeometry = (): void => { settled = true; publish() }
  publish()
  api?.addEventListener('geometrychange', onGeometry)
  window.addEventListener('resize', publish)
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
  resize?.observe(document.body)
  const style = typeof MutationObserver === 'undefined' ? null : new MutationObserver(publish)
  style?.observe(document.body, { attributes: true, attributeFilter: ['style'] })
  return () => {
    api?.removeEventListener('geometrychange', onGeometry)
    window.removeEventListener('resize', publish)
    resize?.disconnect()
    style?.disconnect()
  }
}
