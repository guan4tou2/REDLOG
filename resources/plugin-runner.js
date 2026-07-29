'use strict'
// RedLog plugin runner — executes a 🔴 privileged plugin's code inside an
// isolated Electron utilityProcess. It has NO direct access to RedLog's SQLite
// DB, signing keys, or the main process; everything it can do goes through a
// capability-scoped RPC that the host checks against the operator's grant.
//
// Contract for a plugin's mcpTools module (CommonJS):
//   module.exports = {
//     register(ctx) {
//       // ctx methods are capability-gated: events.query/search/append,
//       // findings.list, config.get, net.fetch — each rejects unless granted.
//       return {
//         tools: [
//           { name: 'lookup', description: '…', inputSchema: {…},
//             run: async (args) => ({ ok: true }) }
//         ]
//       }
//     }
//   }

const port = process.parentPort
let tools = []
const pending = new Map()
let nextId = 1

function post(msg) { port.postMessage(msg) }

// Capability RPC → main. Rejects if the host denies (capability not granted).
function callHost(method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    post({ kind: 'cap', id, method, args })
  })
}

function makeCtx() {
  const c = (method) => (args) => callHost(method, args)
  return {
    events: { query: c('events.query'), search: c('events.search'), append: c('events.append') },
    findings: { list: c('findings.list') },
    config: { get: c('config.get') },
    fetch: c('net.fetch'),
    log: (m) => post({ kind: 'log', message: String(m) })
  }
}

port.on('message', async (e) => {
  const msg = e.data || {}
  try {
    if (msg.kind === 'init') {
      const mod = require(msg.modulePath)
      const reg = typeof mod.register === 'function' ? mod.register(makeCtx()) : mod
      const declared = (reg && reg.tools) || mod.tools || []
      tools = declared.filter((t) => t && typeof t.run === 'function')
      post({
        kind: 'ready',
        tools: tools.map((t) => ({
          name: String(t.name),
          description: String(t.description || ''),
          inputSchema: t.inputSchema || { type: 'object', properties: {} }
        }))
      })
    } else if (msg.kind === 'call') {
      const tool = tools.find((t) => t.name === msg.name || `_${t.name}` === msg.name || msg.name.endsWith(`_${t.name}`))
      if (!tool) { post({ kind: 'call-result', id: msg.id, error: `unknown tool: ${msg.name}` }); return }
      const result = await tool.run(msg.args || {})
      post({ kind: 'call-result', id: msg.id, result })
    } else if (msg.kind === 'cap-result') {
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result) }
    }
  } catch (err) {
    if (msg.kind === 'call') post({ kind: 'call-result', id: msg.id, error: String(err && err.message || err) })
    else if (msg.kind === 'init') post({ kind: 'init-error', error: String(err && err.message || err) })
  }
})
