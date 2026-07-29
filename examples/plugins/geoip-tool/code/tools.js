'use strict'
// Example 🔴 privileged plugin: an MCP tool RedLog runs in an isolated process.
// It only touches RedLog through the capability-scoped `ctx` — here it needs
// `net:outbound` (to call the geoip API) and `write:events` (to log the lookup).
// Both are declared in plugin.json and must be granted by the operator.

module.exports = {
  register(ctx) {
    return {
      tools: [
        {
          name: 'geolocate',
          description: 'Geolocate an IPv4 address and record the lookup in the RedLog timeline.',
          inputSchema: {
            type: 'object',
            properties: { ip: { type: 'string', description: 'IPv4 address to locate' } },
            required: ['ip']
          },
          async run(args) {
            const ip = String(args.ip || '').trim()
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { error: 'not an IPv4 address' }

            // net:outbound — capability-checked by the host
            const resp = await ctx.fetch({ url: `https://ipapi.co/${ip}/json/`, method: 'GET' })
            let geo = {}
            try { geo = JSON.parse(resp.body) } catch { /* leave empty */ }

            // write:events — attributed to this plugin's identity, chained like any event
            await ctx.events.append({
              agent_type: 'agent',
              data: { subtype: 'geoip_lookup', ip, city: geo.city, country: geo.country_name, org: geo.org }
            })
            return { ip, city: geo.city, country: geo.country_name, org: geo.org }
          }
        }
      ]
    }
  }
}
