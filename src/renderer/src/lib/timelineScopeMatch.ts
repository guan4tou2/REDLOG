// Pure scope-matching helpers, lifted from Timeline.tsx so they can be
// unit-tested without a DOM.

export function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0
}

export function matchesScopePattern(target: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const bare = pattern.slice(2)
    return target === bare || target.endsWith('.' + bare)
  }
  if (pattern.includes('/')) {
    const [net, bits] = pattern.split('/')
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) return false
    const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0
    return (ipToLong(target) & mask) === (ipToLong(net) & mask)
  }
  return target === pattern
}
