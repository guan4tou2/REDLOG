// network.showWifiName (G-NET1).
//
// The setting shipped honoured by nothing: Settings wrote it, `detectLink()`
// always probed, and the SSID was always displayed once the OS permission
// existed — whichever way the operator set the toggle. That matters more than a
// cosmetic default, because the SSID names the building the operator is sitting
// in and it rides along on every `ip:status` into the HUD, which is the surface
// guaranteed to be in frame on a screenshot or a screen-share.

import { describe, it, expect } from 'vitest'
import { applyWifiNamePolicy } from '../src/main/services/network-info'
import type { NetworkLink } from '../src/main/services/network-info'

const wifi = (name: string): NetworkLink => ({ type: 'wifi', name })

describe('applyWifiNamePolicy', () => {
  it('off (the default): the SSID is dropped', () => {
    expect(applyWifiNamePolicy(wifi('TARGETCORP-GUEST'), false)).toEqual({ type: 'wifi', name: '' })
  })

  it('off: the link TYPE survives — "on Wi-Fi" is a fact worth showing', () => {
    // The UI renders a generic "Wi-Fi" from the type when the name is blank, so
    // the operator still sees wireless-vs-wired without naming the place.
    expect(applyWifiNamePolicy(wifi('Cafe_Free'), false).type).toBe('wifi')
  })

  it('on: the SSID is shown', () => {
    expect(applyWifiNamePolicy(wifi('TARGETCORP-GUEST'), true)).toEqual({ type: 'wifi', name: 'TARGETCORP-GUEST' })
  })

  const untouched: Array<[string, NetworkLink]> = [
    ['wired', { type: 'wired', name: '' }],
    ['unknown', { type: 'unknown', name: '' }],
    ['wifi with no name (OS withheld it)', { type: 'wifi', name: '' }]
  ]
  for (const [name, link] of untouched) {
    it(`leaves a ${name} link alone either way`, () => {
      expect(applyWifiNamePolicy(link, false)).toEqual(link)
      expect(applyWifiNamePolicy(link, true)).toEqual(link)
    })
  }

  it('does not mutate the link it was handed', () => {
    const original = wifi('KEEPME')
    applyWifiNamePolicy(original, false)
    expect(original.name).toBe('KEEPME')
  })

  it('is idempotent — re-applying an already-redacted link changes nothing', () => {
    const once = applyWifiNamePolicy(wifi('SSID'), false)
    expect(applyWifiNamePolicy(once, false)).toEqual(once)
  })

  it('an SSID that looks like a placeholder is still dropped when off', () => {
    // detectMac already rejects "<redacted>" / "not associated" and yields an
    // empty name; anything that does get through is still gated here.
    expect(applyWifiNamePolicy(wifi('unknown ssid'), false).name).toBe('')
  })
})
