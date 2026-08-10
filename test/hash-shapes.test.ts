import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { buildHashShapes } from '../src/core/chain-anchor'

// v0.11.3: the `chain_sample_broken` root cause, open since v0.7.5.
//
// A 2026-07-28 project tripped the background sampler on a row whose hash
// matched none of the six known shapes. The deferred note assumed a corrupted
// row. Nothing was corrupt — the shapes were reconstructed with the fields in
// the wrong ORDER, and `JSON.stringify` serialises in insertion order.
//
// Commit 33a2c86 wrote:
//
//   const event = { …, targetId, data, prevHash, createdAt }
//   sha256(JSON.stringify({ ...event, hash: undefined, prevHash }))
//
// so `prevHash` sits BEFORE `createdAt`. `buildHashShapes` reconstructed it as
// `{ ...v01, prevHash }`, which puts it AFTER. Identical data, different bytes,
// different hash. f1f7c70 then appended monotonicNs / ntpOffsetMs to that same
// literal, giving a second ordering.
//
// Confirmed against a real operator database: before the inline shapes, the
// full walk stopped at row 108 of 28,338; after, every row verifies.
//
// These tests pin the byte-level ordering. A refactor that "tidies" the field
// order in buildHashShapes would silently un-verify years of chains, and only
// an ordering assertion catches it — the objects stay deep-equal.

const ROW = {
  id: '32457ee3-a17f-4bfa-b568-9bfb814f03f7',
  timestamp: 1785223829501,
  engagement_id: 'default',
  session_id: 'ad36676f-6f99-4cd7-aedc-f5ab82d4d507',
  operator_id: 'operator-1',
  agent_type: 'system',
  hostname: 'Mac',
  source_ip: null,
  target_id: null,
  data: '{"subtype":"session_start"}',
  hash: 'e24a05acf1fc011fe47292d883e9973e0a942d701363468f46f984b445cb657c',
  prev_hash: 'a99f8b66ac05b5835b37a5c1aa15ca3f65788b7996bb1af02a42ec09968121f9',
  created_at: 1785223829501,
  monotonic_ns: null,
  ntp_offset_ms: null
}

const sha = (o: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex')

describe('legacy hash shapes', () => {
  it('reproduces the hash of a real 2026-07-28 row', () => {
    const shapes = buildHashShapes(ROW as never, JSON.parse(ROW.data))
    // This exact row is what the sampler flagged. It is the regression test:
    // if this stops matching, chains from that era stop verifying.
    expect(sha(shapes.v02Inline)).toBe(ROW.hash)
  })

  it('the current v0.2 shape does NOT match it — the two orderings differ', () => {
    const shapes = buildHashShapes(ROW as never, JSON.parse(ROW.data))
    // Not a bug in v02: both shapes are needed, because both were written.
    // Asserted so the distinction cannot be "simplified" away.
    expect(sha(shapes.v02)).not.toBe(ROW.hash)
  })

  it('inline shapes keep prevHash before createdAt', () => {
    const shapes = buildHashShapes(ROW as never, JSON.parse(ROW.data))
    for (const shape of [shapes.v02Inline, shapes.v06Inline]) {
      const keys = Object.keys(shape)
      expect(keys.indexOf('prevHash'), 'prevHash must precede createdAt')
        .toBeLessThan(keys.indexOf('createdAt'))
    }
  })

  it('the appended shapes keep prevHash after createdAt', () => {
    const shapes = buildHashShapes(ROW as never, JSON.parse(ROW.data))
    const keys = Object.keys(shapes.v02)
    expect(keys.indexOf('prevHash')).toBeGreaterThan(keys.indexOf('createdAt'))
  })

  it('v0.6-inline puts the clock fields last', () => {
    const shapes = buildHashShapes(ROW as never, JSON.parse(ROW.data))
    const keys = Object.keys(shapes.v06Inline).filter((k) => k !== 'hash')
    expect(keys.slice(-2)).toEqual(['monotonicNs', 'ntpOffsetMs'])
    expect(keys.indexOf('prevHash')).toBeLessThan(keys.indexOf('createdAt'))
  })
})
