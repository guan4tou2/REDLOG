import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { getActiveBrowserTab, setCdpPort } from '../src/main/services/cdp-connector'

it('distinguishes an unresponsive CDP endpoint from a responding tab on retry', async () => {
  let respond = false
  const server = createServer((_request, response) => {
    if (respond) response.end(JSON.stringify([{ type: 'page', title: 'Recovered', url: 'about:blank' }]))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    setCdpPort((server.address() as AddressInfo).port)
    expect(await getActiveBrowserTab()).toMatchObject({ connected: false, timedOut: true })
    respond = true
    const result = await getActiveBrowserTab()
    expect(result).toMatchObject({ connected: true, title: 'Recovered' })
    expect(result.timedOut).toBeUndefined()
  } finally {
    setCdpPort(9222)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
