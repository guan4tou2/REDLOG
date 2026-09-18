/**
 * dHash (difference hash) — perceptual image fingerprint for dedup.
 *
 * Compares each pixel against its right-hand neighbor in an 8×9 grayscale
 * downsample, producing a 64-bit signature. Small visual changes (mouse
 * cursor, one-line terminal scroll) shift a handful of bits; a whole new
 * window shifts dozens.
 *
 * Extracted from ScreenshotAgent so the pure logic is testable without
 * Electron's NativeImage.
 */

/**
 * Compute a 64-bit dHash from a 9×8 BGRA bitmap buffer.
 * The buffer must be exactly 9 * 8 * 4 = 288 bytes (row-major BGRA).
 */
export function dHashFromBgra(buf: Buffer | Uint8Array): bigint {
  if (buf.length < 288) throw new RangeError(`dHash needs a 9×8 BGRA bitmap (288 bytes), got ${buf.length}`)
  let hash = 0n
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const i = (row * 9 + col) * 4
      const j = (row * 9 + col + 1) * 4
      const a = buf[i] + buf[i + 1] + buf[i + 2]
      const b = buf[j] + buf[j + 1] + buf[j + 2]
      hash = (hash << 1n) | (a > b ? 1n : 0n)
    }
  }
  return hash
}

/** Hamming distance between two 64-bit hashes (popcount of XOR). */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}
