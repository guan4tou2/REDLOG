import { describe, it, expect } from 'vitest'
import { dHashFromBgra, hammingDistance } from '../src/core/dhash'

// Helper: build a 9×8 BGRA buffer from a grayscale grid (0-255 per pixel).
// Each value becomes B=G=R=value, A=255.
function bgra(pixels: number[]): Buffer {
  if (pixels.length !== 72) throw new Error(`need 72 pixels (9×8), got ${pixels.length}`)
  const buf = Buffer.alloc(72 * 4)
  for (let i = 0; i < 72; i++) {
    const v = pixels[i]
    buf[i * 4] = v      // B
    buf[i * 4 + 1] = v  // G
    buf[i * 4 + 2] = v  // R
    buf[i * 4 + 3] = 255
  }
  return buf
}

describe('dHashFromBgra', () => {
  it('returns a 64-bit bigint', () => {
    const pixels = Array.from({ length: 72 }, (_, i) => i * 3)
    const h = dHashFromBgra(bgra(pixels))
    expect(typeof h).toBe('bigint')
    expect(h).toBeGreaterThanOrEqual(0n)
    expect(h).toBeLessThan(1n << 64n)
  })

  it('identical images produce identical hashes', () => {
    const pixels = Array.from({ length: 72 }, (_, i) => (i * 7) % 256)
    expect(dHashFromBgra(bgra(pixels))).toBe(dHashFromBgra(bgra(pixels)))
  })

  it('uniform image produces all-zero hash (no pixel is brighter than its neighbor)', () => {
    const uniform = Array.from({ length: 72 }, () => 128)
    expect(dHashFromBgra(bgra(uniform))).toBe(0n)
  })

  it('gradient left-to-right produces all-ones in each row (every pixel > right neighbor inverted)', () => {
    // Descending gradient: each pixel is brighter than the one to its right,
    // so every comparison bit is 1.
    const descending: number[] = []
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        descending.push(255 - col * 28)
      }
    }
    const h = dHashFromBgra(bgra(descending))
    // All 64 bits set
    expect(h).toBe((1n << 64n) - 1n)
  })

  it('rejects buffer smaller than 288 bytes', () => {
    expect(() => dHashFromBgra(Buffer.alloc(100))).toThrow('288 bytes')
  })

  it('single-pixel change shifts only a few bits', () => {
    const base = Array.from({ length: 72 }, (_, i) => (i * 13) % 256)
    const tweaked = [...base]
    tweaked[36] = (tweaked[36] + 100) % 256 // change one pixel in the middle
    const h1 = dHashFromBgra(bgra(base))
    const h2 = dHashFromBgra(bgra(tweaked))
    const dist = hammingDistance(h1, h2)
    // A single pixel change affects at most 2 comparison bits (left and right neighbor)
    expect(dist).toBeLessThanOrEqual(2)
  })

  it('completely different images have high distance', () => {
    const a = Array.from({ length: 72 }, (_, i) => i % 2 === 0 ? 200 : 50)
    const b = Array.from({ length: 72 }, (_, i) => i % 2 === 0 ? 50 : 200)
    const dist = hammingDistance(dHashFromBgra(bgra(a)), dHashFromBgra(bgra(b)))
    expect(dist).toBeGreaterThan(30)
  })
})

describe('hammingDistance', () => {
  it('identical values have distance 0', () => {
    expect(hammingDistance(0n, 0n)).toBe(0)
    expect(hammingDistance(0xDEADBEEFn, 0xDEADBEEFn)).toBe(0)
  })

  it('single bit difference is 1', () => {
    expect(hammingDistance(0b1000n, 0b0000n)).toBe(1)
    expect(hammingDistance(0n, 1n)).toBe(1)
  })

  it('all 64 bits different is 64', () => {
    const allOnes = (1n << 64n) - 1n
    expect(hammingDistance(0n, allOnes)).toBe(64)
  })

  it('known values', () => {
    // 0xFF = 8 bits set, 0x00 = 0 bits → distance 8
    expect(hammingDistance(0xFFn, 0x00n)).toBe(8)
    // 0b1010 vs 0b0101 → 4 bits differ
    expect(hammingDistance(0b1010n, 0b0101n)).toBe(4)
  })
})

describe('diffThreshold behavior simulation', () => {
  it('mouse cursor jitter (< threshold 5) is filtered', () => {
    // Simulate: nearly identical frames with 2-3 pixels slightly shifted
    const base = Array.from({ length: 72 }, (_, i) => (i * 11 + 30) % 256)
    const jitter = [...base]
    // Slight change in 2 adjacent pixels (cursor moved)
    jitter[10] = (jitter[10] + 15) % 256
    jitter[11] = (jitter[11] + 15) % 256

    const dist = hammingDistance(dHashFromBgra(bgra(base)), dHashFromBgra(bgra(jitter)))
    expect(dist).toBeLessThan(5) // under default threshold
  })

  it('new terminal window (> threshold 5) passes through', () => {
    // dHash compares neighboring pixels within a row, so we need texture
    // differences, not just brightness shifts. Simulate a dark idle desktop
    // vs a terminal window with visible text (alternating bright/dark pixels).
    const idle = Array.from({ length: 72 }, (_, i) => 40 + (i % 3)) // near-uniform dark
    const terminal = Array.from({ length: 72 }, (_, i) =>
      i < 36
        ? 40 + (i % 3)                    // top half unchanged
        : (i % 2 === 0 ? 220 : 30)        // bottom half: high-contrast text pattern
    )
    const dist = hammingDistance(dHashFromBgra(bgra(idle)), dHashFromBgra(bgra(terminal)))
    expect(dist).toBeGreaterThan(5) // above default threshold → stored
  })
})
