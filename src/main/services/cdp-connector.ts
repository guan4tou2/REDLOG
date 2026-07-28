import http from 'http'

interface BrowserTab {
  id: string
  title: string
  url: string
  type: string
  webSocketDebuggerUrl?: string
}

interface BrowserContext {
  url: string | null
  title: string | null
  connected: boolean
}

let cdpPort = 9222
let lastContext: BrowserContext = { url: null, title: null, connected: false }

export function setCdpPort(port: number): void {
  cdpPort = port
}

function fetchJson<T>(url: string, timeout = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error('Invalid JSON'))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
  })
}

export async function getActiveBrowserTab(): Promise<BrowserContext> {
  try {
    const tabs = await fetchJson<BrowserTab[]>(`http://127.0.0.1:${cdpPort}/json`)
    const page = tabs.find((t) => t.type === 'page')
    if (page) {
      lastContext = { url: page.url, title: page.title, connected: true }
    } else {
      lastContext = { url: null, title: null, connected: true }
    }
  } catch {
    lastContext = { url: null, title: null, connected: false }
  }
  return lastContext
}

