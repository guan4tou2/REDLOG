let _geoip: typeof import('geoip-lite') | null = null

async function getGeoIP(): Promise<typeof import('geoip-lite')> {
  if (!_geoip) {
    _geoip = await import('geoip-lite')
  }
  return _geoip
}

export interface GeoResult {
  country: string | null
  region: string | null
  city: string | null
  match: boolean
}

export async function lookupIP(ip: string, expectedCountry: string | null): Promise<GeoResult> {
  try {
    const geoip = await getGeoIP()
    const geo = geoip.lookup(ip)
    if (!geo) return { country: null, region: null, city: null, match: expectedCountry === null }

    return {
      country: geo.country,
      region: geo.region,
      city: geo.city,
      match: expectedCountry === null || geo.country === expectedCountry.toUpperCase()
    }
  } catch {
    return { country: null, region: null, city: null, match: true }
  }
}
