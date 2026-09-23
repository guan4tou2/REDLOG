import { describe, it, expect } from 'vitest'
import { linkForDisplay } from '../src/main/services/network-info'

// docs/TESTING.md §5.6: the SSID names the building you are sitting in, and
// the HUD is the surface most likely to be in frame on a screenshot. Off means
// dropped before any surface sees it, keeping the link type.
describe('Wi-Fi name display', () => {
  it('drops the SSID when showWifiName is off, keeping the link type', () => {
    expect(linkForDisplay({ type: 'wifi', name: 'Client-HQ-5G' }, false)).toEqual({ type: 'wifi', name: '' })
  })

  it('shows it when on', () => {
    expect(linkForDisplay({ type: 'wifi', name: 'Client-HQ-5G' }, true)).toEqual({ type: 'wifi', name: 'Client-HQ-5G' })
  })

  it('leaves a wired link alone', () => {
    expect(linkForDisplay({ type: 'wired', name: '' }, false)).toEqual({ type: 'wired', name: '' })
  })
})
