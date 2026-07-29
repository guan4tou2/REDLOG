import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerPluginTools, unregisterPluginTools, methodAllowed, type PluginToolDispatch } from './tool-registry'
import type { LoadedPlugin, Capability } from './types'

// Runs 🔴 privileged plugin code in an isolated Electron utilityProcess. The
// child (resources/plugin-runner.js) can only reach RedLog through the
// capability-scoped RPC served here — it never sees the DB handle, the signing
// keys, or the main process. Every ctx call is checked against the operator's
// granted capabilities before the host executes it.

// Services the host exposes to plugins, gated by capability. Provided by main so
// this module stays free of DB/API wiring.
export interface PluginServices {
  queryEvents: (args: Record<string, unknown>) => unknown
  searchEvents: (args: Record<string, unknown>) => unknown
  appendEvent: (pluginId: string, args: Record<string, unknown>) => unknown
  listFindings: (args: Record<string, unknown>) => unknown
  getConfig: () => unknown
  fetch: (args: Record<string, unknown>) => Promise<unknown>
}

interface Running {
  proc: UtilityProcess
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  nextId: number
}

function runnerPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'plugin-runner.js')
  if (process.resourcesPath && existsSync(packaged)) return packaged
  const devA = join(__dirname, '../../../resources/plugin-runner.js')
  const devB = join(__dirname, '../../resources/plugin-runner.js')
  return existsSync(devA) ? devA : devB
}

export function createPluginHost(services: PluginServices): {
  start: (p: LoadedPlugin) => void
  stop: (pluginId: string) => void
} {
  const running = new Map<string, Running>()

  const serveCap = async (pluginId: string, granted: Capability[], method: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!methodAllowed(method, granted)) throw new Error(`capability denied: ${method}`)
    switch (method) {
      case 'events.query': return services.queryEvents(args)
      case 'events.search': return services.searchEvents(args)
      case 'events.append': return services.appendEvent(pluginId, args)
      case 'findings.list': return services.listFindings(args)
      case 'config.get': return services.getConfig()
      case 'net.fetch': return services.fetch(args)
      default: throw new Error(`unknown method: ${method}`)
    }
  }

  const start = (p: LoadedPlugin): void => {
    const modRel = p.manifest.contributes.mcpTools
    if (!modRel) return // only mcpTools code is executed in v1
    if (running.has(p.manifest.id)) stop(p.manifest.id)

    const granted = (p.manifest.capabilities ?? []) as Capability[]
    let proc: UtilityProcess
    try {
      proc = utilityProcess.fork(runnerPath(), [], {
        serviceName: `redlog-plugin-${p.manifest.id}`,
        stdio: 'ignore'
      })
    } catch (e) {
      console.error(`[plugins] failed to fork ${p.manifest.id}:`, e)
      return
    }
    const state: Running = { proc, pending: new Map(), nextId: 1 }
    running.set(p.manifest.id, state)

    const dispatch: PluginToolDispatch = (name, args) => new Promise((resolve, reject) => {
      const id = state.nextId++
      state.pending.set(id, { resolve, reject })
      // guard against a hung plugin
      const timer = setTimeout(() => {
        if (state.pending.delete(id)) reject(new Error('plugin tool timed out'))
      }, 30_000)
      const orig = state.pending.get(id)!
      state.pending.set(id, { resolve: (v) => { clearTimeout(timer); orig.resolve(v) }, reject: (e) => { clearTimeout(timer); orig.reject(e) } })
      proc.postMessage({ kind: 'call', id, name, args })
    })

    proc.on('message', async (msg: Record<string, unknown>) => {
      const kind = msg?.kind
      if (kind === 'ready') {
        const tools = (msg.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) ?? []
        registerPluginTools(p.manifest.id, tools, dispatch)
        console.log(`[plugins] ${p.manifest.id}: ${tools.length} tool(s) live`)
      } else if (kind === 'init-error') {
        console.error(`[plugins] ${p.manifest.id} init failed:`, msg.error)
      } else if (kind === 'log') {
        console.log(`[plugin:${p.manifest.id}]`, msg.message)
      } else if (kind === 'call-result') {
        const waiter = state.pending.get(msg.id as number)
        if (waiter) { state.pending.delete(msg.id as number); msg.error ? waiter.reject(new Error(String(msg.error))) : waiter.resolve(msg.result) }
      } else if (kind === 'cap') {
        try {
          const result = await serveCap(p.manifest.id, granted, String(msg.method), (msg.args as Record<string, unknown>) ?? {})
          proc.postMessage({ kind: 'cap-result', id: msg.id, result })
        } catch (e) {
          proc.postMessage({ kind: 'cap-result', id: msg.id, error: (e as Error).message })
        }
      }
    })
    proc.on('exit', () => {
      unregisterPluginTools(p.manifest.id)
      running.delete(p.manifest.id)
    })

    // hand the child its module + capabilities
    proc.postMessage({ kind: 'init', modulePath: join(p.dir, modRel), dir: p.dir, capabilities: granted })
  }

  const stop = (pluginId: string): void => {
    const state = running.get(pluginId)
    if (!state) return
    unregisterPluginTools(pluginId)
    try { state.proc.kill() } catch { /* already gone */ }
    running.delete(pluginId)
  }

  return { start, stop }
}
