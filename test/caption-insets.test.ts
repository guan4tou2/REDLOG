// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  FALLBACK_HEIGHT_PX,
  FALLBACK_RIGHT_PX,
  NO_INSET,
  captionInsets,
  installCaptionInsets
} from '../src/renderer/src/lib/captionInsets'

// The OS window buttons are drawn over the page on Windows and Linux. These pin
// the arithmetic that keeps the page out from under them: the overlay reports
// CSS pixels of the window, the page is drawn at `body { zoom }`, so the
// reservation is the overlay's reach divided by the zoom.

// A Windows overlay: three 46px buttons in a 40px strip, in a 1400px window.
const WIN = { visible: true, rect: { x: 0, y: 0, width: 1400 - 138, height: 40 } }

describe('captionInsets', () => {
  const cases: Array<[string, Parameters<typeof captionInsets>[0], { right: number; height: number }]> = [
    ['default zoom 0.9', { isMac: false, reading: WIN, settled: true, viewportWidth: 1400, zoom: 0.9 }, { right: 153.33, height: 44.44 }],
    ['zoom 0.8', { isMac: false, reading: WIN, settled: true, viewportWidth: 1400, zoom: 0.8 }, { right: 172.5, height: 50 }],
    ['zoom 1.0', { isMac: false, reading: WIN, settled: true, viewportWidth: 1400, zoom: 1 }, { right: 138, height: 40 }],
    ['zoom 1.1', { isMac: false, reading: WIN, settled: true, viewportWidth: 1400, zoom: 1.1 }, { right: 125.45, height: 36.36 }],
    ['maximised: wider window, same buttons', { isMac: false, reading: { visible: true, rect: { x: 0, y: 0, width: 1920 - 138, height: 40 } }, settled: true, viewportWidth: 1920, zoom: 0.9 }, { right: 153.33, height: 44.44 }],
    ['narrow window at the 800 floor', { isMac: false, reading: { visible: true, rect: { x: 0, y: 0, width: 800 - 138, height: 40 } }, settled: true, viewportWidth: 800, zoom: 0.9 }, { right: 153.33, height: 44.44 }],
    ['a taller strip counts its top offset', { isMac: false, reading: { visible: true, rect: { x: 0, y: 2, width: 1262, height: 40 } }, settled: true, viewportWidth: 1400, zoom: 1 }, { right: 138, height: 42 }],
    ['macOS reserves nothing, whatever the API says', { isMac: true, reading: WIN, settled: true, viewportWidth: 1400, zoom: 0.9 }, NO_INSET],
    ['macOS with no API', { isMac: true, reading: null, settled: false, viewportWidth: 1400, zoom: 0.9 }, NO_INSET],
    ['full screen: reported, nothing drawn', { isMac: false, reading: { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } }, settled: true, viewportWidth: 1400, zoom: 0.9 }, NO_INSET],
    ['not visible and not yet reported: conservative', { isMac: false, reading: { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } }, settled: false, viewportWidth: 1400, zoom: 1 }, { right: FALLBACK_RIGHT_PX, height: FALLBACK_HEIGHT_PX }],
    ['API absent on a non-Mac platform: conservative, divided by zoom', { isMac: false, reading: null, settled: false, viewportWidth: 1400, zoom: 0.9 }, { right: 166.67, height: 44.44 }],
    ['a bad zoom falls back to the default one', { isMac: false, reading: WIN, settled: true, viewportWidth: 1400, zoom: 0 }, { right: 153.33, height: 44.44 }],
    ['a rect wider than the viewport never goes negative', { isMac: false, reading: { visible: true, rect: { x: 0, y: 0, width: 2000, height: 40 } }, settled: true, viewportWidth: 1400, zoom: 1 }, { right: 0, height: 40 }]
  ]
  it.each(cases)('%s', (_name, input, expected) => {
    expect(captionInsets(input)).toEqual(expected)
  })
})

describe('installCaptionInsets', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
    Reflect.deleteProperty(navigator, 'windowControlsOverlay')
  })
  const prop = (n: string): string => document.documentElement.style.getPropertyValue(n)
  function fakeOverlay(initial: { visible: boolean; width: number }) {
    const target = new EventTarget() as EventTarget & { visible: boolean; getTitlebarAreaRect: () => DOMRectInit }
    target.visible = initial.visible
    let width = initial.width
    target.getTitlebarAreaRect = () => ({ x: 0, y: 0, width, height: 40 })
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: target })
    return { target, setWidth: (w: number) => { width = w } }
  }
  const setWindowWidth = (w: number): void => { Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w }) }

  it('publishes the measured inset and follows geometrychange and the zoom', async () => {
    document.body.style.setProperty('--app-zoom', '0.9')
    setWindowWidth(1400)
    const overlay = fakeOverlay({ visible: true, width: 1262 })
    stop = installCaptionInsets(false)
    expect(prop('--wco-inset-right')).toBe('153.33px')
    expect(prop('--wco-height')).toBe('44.44px')

    overlay.setWidth(1920 - 138); setWindowWidth(1920)
    overlay.target.dispatchEvent(new Event('geometrychange'))
    expect(prop('--wco-inset-right')).toBe('153.33px')

    document.body.style.setProperty('--app-zoom', '1')
    await new Promise((r) => setTimeout(r, 0)) // MutationObserver is a microtask
    expect(prop('--wco-inset-right')).toBe('138px')
  })

  it('reserves the fallback before the API has spoken, then nothing once it reports no overlay', () => {
    document.body.style.setProperty('--app-zoom', '1')
    const overlay = fakeOverlay({ visible: false, width: 0 })
    stop = installCaptionInsets(false)
    expect(prop('--wco-inset-right')).toBe(`${FALLBACK_RIGHT_PX}px`)
    overlay.target.dispatchEvent(new Event('geometrychange'))
    expect(prop('--wco-inset-right')).toBe('0px')
    expect(prop('--wco-height')).toBe('0px')
  })

  it('publishes zero on macOS', () => {
    fakeOverlay({ visible: true, width: 1262 })
    stop = installCaptionInsets(true)
    expect(prop('--wco-inset-right')).toBe('0px')
    expect(prop('--wco-height')).toBe('0px')
  })
})
