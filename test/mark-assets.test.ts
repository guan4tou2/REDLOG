import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

// Guards for docs/UIUX-STANDARD.md §16 — the shipped mark.
//
// This one exists because the standard said the old logo "was replaced" for
// eight months while every icon the app actually shipped was still the old one:
// gradient plate, gradient R, slash, outer glow. A document cannot notice that.
// So the rules that matter are asserted against the bytes on disk instead —
// including the two that a human eye would have to be looking for to catch:
// that the 16px icon really is the collapsed dot and not a mushed ring, and
// that the menu-bar template really is black-plus-alpha.

const ROOT = path.join(__dirname, '..')
const R = (...p: string[]): string => path.join(ROOT, ...p)
const read = (...p: string[]): Buffer => fs.readFileSync(R(...p))
const text = (...p: string[]): string => read(...p).toString('utf-8')

const MASTER_RING = R('design', 'assets', 'redlog-mark.svg')
const MASTER_DOT = R('design', 'assets', 'redlog-mark-small.svg')

const MARK_RED = '#d75f63'
const MARK_INK = '#16090a'
// The old logo's vocabulary. Any of these back in a shipped SVG means the swap
// was reverted or a stale file crept back in.
const OLD_LOGO_MARKERS = ['linearGradient', 'feGaussianBlur', 'filter=', '#ef4444', '#b91c1c', '#dc2626']

const SHIPPED_SVGS = [
  ['resources', 'icon.svg'],
  ['resources', 'icon-small.svg'],
  ['resources', 'tray-icon.svg'],
  ['src', 'renderer', 'src', 'assets', 'mark.svg'],
  ['src', 'renderer', 'src', 'assets', 'mark-small.svg']
]

// ---------------------------------------------------------------- PNG reading

interface Png { width: number; height: number; px: (x: number, y: number) => [number, number, number, number] }

/** Decode an 8-bit RGBA non-interlaced PNG. Enough for our own assets, and it
 *  keeps this guard dependency-free — no image library in devDependencies. */
function decodePng(buf: Buffer): Png {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  let off = 8
  let ihdr: Buffer | null = null
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('ascii')
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') ihdr = Buffer.from(body)
    if (type === 'IDAT') idat.push(Buffer.from(body))
    if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('no IHDR')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  expect(ihdr[8], 'bit depth').toBe(8)
  expect(ihdr[9], 'colour type must be RGBA').toBe(6)
  expect(ihdr[12], 'interlacing not supported by this reader').toBe(0)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  let pos = 0
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++]
    for (let x = 0; x < stride; x++) {
      const rv = raw[pos + x]
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let v: number
      if (ft === 0) v = rv
      else if (ft === 1) v = rv + a
      else if (ft === 2) v = rv + b
      else if (ft === 3) v = rv + ((a + b) >> 1)
      else if (ft === 4) v = rv + paeth(a, b, c)
      else throw new Error(`filter ${ft}`)
      out[y * stride + x] = v & 0xff
    }
    pos += stride
  }
  return {
    width,
    height,
    px: (x, y) => [
      out[y * stride + x * 4], out[y * stride + x * 4 + 1],
      out[y * stride + x * 4 + 2], out[y * stride + x * 4 + 3]
    ]
  }
}

const png = (...p: string[]): Png => decodePng(read(...p))
const hex = ([r, g, b]: number[]): string =>
  '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')

/** Classify the centre row of an app icon into runs of plate / ink / clear.
 *  This is how "the ring collapsed to a dot" becomes an assertion: a ring shows
 *  up as ink-plate-ink either side of centre, a solid dot as a single ink run. */
function centreRowRuns(p: Png): string[] {
  const y = Math.floor(p.height / 2)
  const runs: string[] = []
  for (let x = 0; x < p.width; x++) {
    const [r, g, b, a] = p.px(x, y)
    // Antialiased edge pixels sit between the two flats; bucket by which they
    // are nearer to, so a half-covered pixel does not invent a run of its own.
    const kind = a < 128 ? 'clear' : r + g + b < 300 ? 'ink' : 'plate'
    if (runs[runs.length - 1] !== kind) runs.push(kind)
  }
  return runs
}

// ---------------------------------------------------------------------- tests

describe('the masters are the single source', () => {
  it('ships byte-identical copies, so resources/ and the bundle cannot drift', () => {
    const ring = fs.readFileSync(MASTER_RING)
    const dot = fs.readFileSync(MASTER_DOT)
    expect(read('resources', 'icon.svg').equals(ring)).toBe(true)
    expect(read('src', 'renderer', 'src', 'assets', 'mark.svg').equals(ring)).toBe(true)
    expect(read('resources', 'icon-small.svg').equals(dot)).toBe(true)
    expect(read('src', 'renderer', 'src', 'assets', 'mark-small.svg').equals(dot)).toBe(true)
  })

  it('draws the mark in the mark colour and nothing else', () => {
    const ring = fs.readFileSync(MASTER_RING).toString('utf-8')
    expect(ring).toContain(MARK_RED)
    expect(ring).toContain(MARK_INK)
    expect(fs.readFileSync(MASTER_DOT).toString('utf-8')).toContain(MARK_RED)
  })
})

describe('the old logo cannot come back', () => {
  for (const parts of SHIPPED_SVGS) {
    it(`${parts.join('/')} carries none of its vocabulary`, () => {
      const svg = text(...parts)
      for (const marker of OLD_LOGO_MARKERS) {
        expect(svg, `${parts.join('/')} still contains ${marker}`).not.toContain(marker)
      }
    })
  }

  it('has no wordmark SVG anywhere — §16 says it is live text by ruling', () => {
    expect(fs.existsSync(R('resources', 'logo.svg'))).toBe(false)
    expect(fs.existsSync(R('src', 'renderer', 'src', 'assets', 'logo.svg'))).toBe(false)
  })

  it('leaves no raster copy of it hiding in the source', () => {
    // The tray's data-URL fallback was a base64 PNG of the old glyph, and a
    // stale compiled bundle at the repo root carried a second copy of the same
    // string. Neither is reachable by a file-by-file swap of resources/.
    // Assembled from halves so this file is not its own first hit. The first
    // half is just a 32x32 PNG header and the current fallback shares it; the
    // tail is what identifies the old glyph.
    const OLD_FALLBACK = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0' + 'AAAAh0lEQVR4'
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { if (!['node_modules', 'out', 'dist', '.git'].includes(e.name)) walk(full) }
        else if (/\.(ts|tsx|js|jsx|html)$/.test(e.name) &&
                 fs.readFileSync(full, 'utf-8').includes(OLD_FALLBACK)) {
          hits.push(path.relative(ROOT, full).split(path.sep).join('/'))
        }
      }
    }
    walk(ROOT)
    expect(hits).toEqual([])
  })

  it('is not imported by any source file', () => {
    const seen: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(e.name) && fs.readFileSync(full, 'utf-8').includes('logo.svg')) {
          seen.push(path.relative(ROOT, full).split(path.sep).join('/'))
        }
      }
    }
    walk(R('src'))
    expect(seen).toEqual([])
  })
})

describe('the app icon set', () => {
  const SIZES = [16, 32, 64, 128, 256, 512, 1024]

  for (const size of SIZES) {
    it(`icon-${size}.png is ${size}×${size} RGBA`, () => {
      const p = png('resources', `icon-${size}.png`)
      expect([p.width, p.height]).toEqual([size, size])
    })
  }

  it('collapses the ring to a solid dot at 16px', () => {
    // plate · dot · plate — one ink run, so no ring.
    expect(centreRowRuns(png('resources', 'icon-16.png'))).toEqual(['plate', 'ink', 'plate'])
  })

  it('keeps the ring from 32px up', () => {
    for (const size of [32, 64, 128, 256, 512, 1024]) {
      // plate · ring · gap · dot · gap · ring · plate
      expect(centreRowRuns(png('resources', `icon-${size}.png`)), `at ${size}px`)
        .toEqual(['plate', 'ink', 'plate', 'ink', 'plate', 'ink', 'plate'])
    }
  })

  it('paints the plate in the mark colour, not the old red', () => {
    const p = png('resources', 'icon-256.png')
    expect(hex(p.px(Math.floor(p.width / 2), 8))).toBe(MARK_RED)
    expect(hex(p.px(Math.floor(p.width / 2), Math.floor(p.height / 2)))).toBe(MARK_INK)
  })

  it('cuts the corners rather than rounding them', () => {
    // Top-left is cut at 22% of the side, so the very first pixel is empty and
    // a pixel just inside the diagonal is plate. A rounded square would leave
    // the corner empty too — the diagonal is what tells them apart, so sample
    // a point the arc of a 22%-radius round would still have excluded.
    const p = png('resources', 'icon-256.png')
    const cut = Math.round(p.width * 0.22)
    expect(p.px(1, 1)[3], 'corner must be cut away').toBeLessThan(16)
    expect(p.px(cut + 3, 3)[3], 'just past the cut, on the top edge').toBeGreaterThan(240)
    expect(p.px(3, cut + 3)[3], 'just past the cut, on the left edge').toBeGreaterThan(240)
  })
})

describe('the menu bar set', () => {
  it('is a real template image: black plus alpha, nothing else', () => {
    for (const name of ['tray-iconTemplate.png', 'tray-iconTemplate@2x.png']) {
      const p = png('resources', name)
      for (let y = 0; y < p.height; y++) {
        for (let x = 0; x < p.width; x++) {
          const [r, g, b] = p.px(x, y)
          expect([r, g, b], `${name} at ${x},${y} is not black`).toEqual([0, 0, 0])
        }
      }
    }
  })

  it('sizes 1x and 2x so createFromPath can pair them', () => {
    expect([png('resources', 'tray-iconTemplate.png').width]).toEqual([16])
    expect([png('resources', 'tray-iconTemplate@2x.png').width]).toEqual([32])
  })

  it('recording uses the mark colour, never danger red', () => {
    const p = png('resources', 'tray-icon-rec.png')
    const opaque = new Set<string>()
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const c = p.px(x, y)
        if (c[3] === 255) opaque.add(hex(c))
      }
    }
    expect([...opaque]).toEqual([MARK_RED])
  })

  it('paused is the same glyph dimmed, so macOS can still tint it', () => {
    const p = png('resources', 'tray-icon-paused.png')
    let max = 0
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const [r, g, b, a] = p.px(x, y)
        expect([r, g, b]).toEqual([0, 0, 0])
        max = Math.max(max, a)
      }
    }
    expect(max).toBeGreaterThan(0)
    expect(max, 'paused must read as dimmed, not solid').toBeLessThan(200)
  })

  it('gives Windows and Linux a coloured set, where template rendering does nothing', () => {
    // setTemplateImage is macOS-only. Black-plus-alpha there is just black, and
    // black on a dark taskbar is nothing at all.
    for (const name of ['tray-icon-idle.png', 'tray-icon-idle@2x.png']) {
      const p = png('resources', name)
      const opaque = new Set<string>()
      for (let y = 0; y < p.height; y++) {
        for (let x = 0; x < p.width; x++) {
          const c = p.px(x, y)
          if (c[3] === 255) opaque.add(hex(c))
        }
      }
      expect([...opaque], name).toEqual([MARK_RED])
    }
    const dim = png('resources', 'tray-icon-idle-dim.png')
    let max = 0
    for (let y = 0; y < dim.height; y++) {
      for (let x = 0; x < dim.width; x++) max = Math.max(max, dim.px(x, y)[3])
    }
    expect(max).toBeGreaterThan(0)
    expect(max, 'the non-mac paused glyph must read as dimmed').toBeLessThan(200)
  })

  it('chooses the set by platform rather than shipping one that only suits macOS', () => {
    const tray = text('src', 'main', 'tray.ts')
    expect(tray).toContain("process.platform === 'darwin'")
    for (const name of ['tray-iconTemplate.png', 'tray-icon-idle.png',
                        'tray-icon-paused.png', 'tray-icon-idle-dim.png']) {
      expect(tray, `tray.ts never loads ${name}`).toContain(name)
    }
  })

  it('is loaded by path, because only that pairs the @2x file', () => {
    const tray = text('src', 'main', 'tray.ts')
    expect(tray).toMatch(/nativeImage\.createFromPath\s*\(/)
    // The call, not the word — the comment above it names the API it replaced.
    expect(tray, 'createFromBuffer cannot find the @2x neighbour')
      .not.toMatch(/nativeImage\.createFromBuffer\s*\(/)
  })
})

describe('the render sites', () => {
  const APP = text('src', 'renderer', 'src', 'App.tsx')
  const PICKER = text('src', 'renderer', 'src', 'components', 'ProjectPicker.tsx')

  it('picks the variant that matches the size it renders at', () => {
    // 16 CSS px in the title bar, 56 in the picker. RING_MIN_PX in
    // tools/make-icons.py puts the boundary at 32.
    expect(APP).toContain("assets/mark-small.svg")
    expect(PICKER).toContain("assets/mark.svg")
    expect(PICKER, 'the picker renders at 56px and must not use the small one')
      .not.toContain('mark-small.svg')
  })

  it('does not round off the corners the mark deliberately leaves square', () => {
    for (const [name, src] of [['App.tsx', APP], ['ProjectPicker.tsx', PICKER]] as const) {
      const img = /<img[^>]*src=\{markUrl\}[^>]*>/.exec(src)
      expect(img, `no mark <img> found in ${name}`).not.toBeNull()
      expect(img![0], `${name} rounds the mark`).not.toMatch(/\brounded(-[a-z0-9]+)?\b/)
    }
  })
})

describe('the Windows icon', () => {
  it('carries every size Windows asks for, each as its own render', () => {
    const ico = read('resources', 'icon.ico')
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2), 'type 1 = icon').toBe(1)
    const count = ico.readUInt16LE(4)
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16
      sizes.push(ico[e] === 0 ? 256 : ico[e])
      const bytes = ico.readUInt32LE(e + 8)
      const offset = ico.readUInt32LE(e + 12)
      expect(ico.subarray(offset, offset + 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(offset + bytes).toBeLessThanOrEqual(ico.length)
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256])
  })

  it('is what electron-builder actually packs', () => {
    expect(text('electron-builder.yml')).toContain('icon: resources/icon.ico')
  })
})
