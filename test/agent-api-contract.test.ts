// Agent-facing copies are checked against production source, never each other.
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

const root = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-agent-contract-'))
const oldHome = process.env.HOME
const oldProfile = process.env.USERPROFILE
let dispatch: (req: http.IncomingMessage, res: http.ServerResponse) => void
let api: typeof import('../src/core/api-server')
let db: typeof import('../src/core/db/index')
let health: typeof import('../src/core/capture-health')

beforeAll(async () => {
  process.env.HOME = home
  process.env.USERPROFILE = home
  // Only the transport is replaced. Authentication, policy, ingest, SQLite,
  // response serialization and capture-health are the production handlers.
  vi.spyOn(http, 'createServer').mockImplementation(((handler: typeof dispatch) => {
    dispatch = handler
    const server = new EventEmitter() as http.Server
    server.listen = ((_port: number, _host: string, done: () => void) => { queueMicrotask(done); return server }) as never
    server.address = () => ({ port: 6660, address: '127.0.0.1', family: 'IPv4' })
    server.close = (() => server) as never
    return server
  }) as never)
  db = await import('../src/core/db/index')
  api = await import('../src/core/api-server')
  health = await import('../src/core/capture-health')
  db.initDB(path.join(home, 'project'))
  db.bindDBEngagement('contract')
  api.configureApi({ engagementId: 'contract', operatorId: 'contract-op', operatorName: 'Contract' })
  await api.startApiServer()
  api.onApiProjectOpen()
})
afterAll(async () => {
  api?.stopApiServer()
  ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
  db?.closeDB()
  vi.restoreAllMocks()
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile
  fs.rmSync(home, { recursive: true, force: true })
})

function call(method: string, url: string, body?: object): Promise<{ status: number; body: any }> {
  return new Promise(resolve => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as http.IncomingMessage
    Object.assign(req, { method, url, headers: { host: 'localhost', authorization: `Bearer ${api.getApiToken()}` }, socket: { remoteAddress: '127.0.0.1' } })
    let status = 200
    const res = { setHeader() {}, writeHead(code: number) { status = code }, end(raw: string) { resolve({ status, body: JSON.parse(raw) }) } } as unknown as http.ServerResponse
    dispatch(req, res)
  })
}

it('characterizes every formerly recommended type through the real event handler and health TTL', async () => {
  const accepted = ['shell', 'scanner', 'agent', 'dns', 'credential_use', 'file_transfer', 'marker', 'terminal', 'external', 'process', 'screenshot', 'browser', 'http_navigation', 'pcap']
  for (const agent_type of accepted) {
    const res = await call('POST', '/api/events', { agent_type, data: { contract: agent_type } })
    expect(res.status, `${agent_type}: ${JSON.stringify(res.body)}`).toBe(201)
  }
  expect(health.getCaptureHealth().verdict).not.toBe('dark')
  for (const agent_type of ['pivot', 'loot', 'c2_checkin', 'system', 'recon', 'exploit', 'cleanup', 'acme_scan']) {
    const res = await call('POST', '/api/events', { agent_type, data: {} })
    expect(res).toEqual({ status: 403, body: { error: `agent_type "${agent_type}" is not allowed via external API` } })
    const now = Date.now()
    expect(health.getCaptureHealth(now).verdict).toBe('dark')
    expect(health.getCaptureHealth(now).lastDbError?.source).toBe('api-external-rejected')
    expect(health.getCaptureHealth(now + 60_001).lastDbError).toBeUndefined()
    expect(health.getCaptureHealth(now + 60_001).verdict).not.toBe('dark')
    console.log(`${agent_type}: ${res.status} ${JSON.stringify(res.body)}; health dark, expires after 60000ms`)
  }
  expect((await call('POST', '/api/events', { agent_type: 'system', data: { subtype: 'producer_heartbeat', producer: 'contract' } })).status).toBe(201)
})

it('characterizes target/notes persistence and the unvalidated severity without adding API aliases', async () => {
  const wrong = await call('POST', '/api/marker', { title: 'wrong keys', target: 'lost.example', note: 'lost', severity: 'high' })
  expect(wrong.status).toBe(201)
  expect(wrong.body.targetId).toBeFalsy()
  expect(wrong.body.data.notes).toBe('')
  expect(wrong.body.data.severity).toBe('high')
  const right = await call('POST', '/api/marker', { title: 'right keys', target_id: 'kept.example', notes: 'kept', severity: 'important' })
  expect(right.status).toBe(201)
  expect(right.body.targetId).toBe('kept.example')
  expect(right.body.data.notes).toBe('kept')
  console.log('marker: target/note lost; target_id/notes persisted; high stored unchanged (UI vocabulary is separate)')
})

// Run the actual CLI with a transport preload; no socket or operator token.
import { spawnSync } from 'node:child_process'
function cli(args: string[], status = 403, body = '{"error":"refused by server"}') {
  const preload = path.join(home, 'http.cjs')
  fs.writeFileSync(preload, `const http = require('http'), {EventEmitter} = require('events');
    http.request = (opts, cb) => { const req = new EventEmitter(); let body = '';
      req.write = x => { body += x }; req.end = () => {
        if (process.env.CAPTURE_REQUEST) process.stdout.write(body);
        const res = new EventEmitter(); res.statusCode = ${status}; res.headers = {};
        cb(res); res.emit('data', Buffer.from(${JSON.stringify(body)})); res.emit('end');
      }; return req;
    };`)
  return spawnSync(process.execPath, ['--require', preload, path.join(root, 'cli/redlog-cli.js'), ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home, USERPROFILE: home, CAPTURE_REQUEST: status === 201 ? '1' : '' }
  })
}
it('redlog-cli failed requests preserve the server message and exit nonzero', async () => {
  const refused = await call('POST', '/api/events', { agent_type: 'pivot', data: {} })
  const body = JSON.stringify(refused.body)
  for (const args of [['events'], ['loot', 'text'], ['screenshot'], ['status'], ['health'], ['chain', 'anchor'], ['chain', 'export-ots', 'id']]) {
    const res = cli(args, refused.status, body)
    expect(res.status, args.join(' ')).not.toBe(0)
    expect(res.stderr).toContain('403')
    expect(res.stderr).toBe(`Error 403: ${body}\n`)
  }
})
it('redlog-cli maps --note to the marker notes field and keeps --notes working', async () => {
  for (const flag of ['--note', '--notes']) {
    const res = cli(['mark', 'Finding', flag, 'kept', '--target', 'kept.example'], 201, '{"id":"marker"}')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('"notes":"kept"')
    expect(res.stdout).toContain('"target_id":"kept.example"')
    const saved = await call('POST', '/api/marker', JSON.parse(res.stdout.split('Marker created:')[0]))
    expect(saved.body.data.notes).toBe('kept')
    expect(saved.body.targetId).toBe('kept.example')
  }
})
it('shell helper reports status and body on stderr and preserves failure through redlog_status', async () => {
  const refused = await call('POST', '/api/events', { agent_type: 'pivot', data: {} })
  const body = JSON.stringify(refused.body)
  for (const command of ['redlog_event agent "{}"', 'redlog_scope', 'redlog_status']) {
    const script = `source "$1"
      _redlog_curl_authed() {
        case " $* " in *" -sf "*) return 22;; esac
        printf '%s\\n403' '${body}'
      }
      ${command}`
    const res = spawnSync('bash', ['-c', script, 'contract', path.join(root, 'shell/redlog-agent.sh')], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home }
    })
    expect(res.status, command).not.toBe(0)
    expect(res.stderr).toBe(`[redlog] HTTP 403\n${body}\n`)
    expect(res.stdout).toBe('')
  }
})

import ts from 'typescript'
import { isExternalEventAllowed } from '../src/core/external-event-policy'

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  node.forEachChild(child => walk(child, visit))
}
const source = (name: string, text = read(name)) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
interface Route { method: string; path: string; fields: Set<string>; matches: (path: string) => boolean }
function serverContract(): Route[] {
  const file = source('src/core/api-server.ts')
  const regexes = new Map<string, RegExp>()
  walk(file, n => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)
      && n.initializer.expression.getText(file) === 'route.match') {
      const raw = n.initializer.arguments[0].getText(file)
      regexes.set(n.name.getText(file), new RegExp(raw.slice(1, raw.lastIndexOf('/'))))
    }
  })
  const routes: Route[] = []
  walk(file, n => {
    if (!ts.isIfStatement(n)) return
    const condition = n.expression.getText(file)
    const method = /req\.method === '(GET|POST)'/.exec(condition)?.[1]
    if (!method) return
    const literal = /route === '(\/api\/[^']+)'/.exec(condition)?.[1]
    const regex = [...regexes].find(([name]) => new RegExp(`\\b${name}\\b`).test(condition))?.[1]
    if (!literal && !regex) return
    const fields = new Set<string>()
    const body = n.thenStatement.getText(file)
    const collectFields = (node: ts.Node, sf: ts.SourceFile) => walk(node, p => {
      if (ts.isPropertyAccessExpression(p) && p.expression.getText(sf) === 'body') fields.add(p.name.text)
      if (ts.isCallExpression(p) && p.expression.getText(sf) === 'url.searchParams.get' && ts.isStringLiteral(p.arguments[0])) fields.add(p.arguments[0].text)
    })
    collectFields(n.thenStatement, file)
    if (body.includes('bodyTargetId(body)')) {
      const helper = source('src/core/ingest/body-target.ts')
      collectFields(helper, helper)
    }
    if (body.includes('parseRecordingAction(')) {
      const parser = source('src/core/api-request.ts')
      walk(parser, p => {
        if (ts.isFunctionDeclaration(p) && p.name?.text === 'parseRecordingAction') collectFields(p, parser)
      })
    }
    routes.push({ method, path: literal ?? regex!.source, fields,
      matches: p => literal ? p === literal : regex!.test(p) })
  })
  return routes
}
const concretePath = (p: string) => p.split('?')[0]
  .replace(/:id|\$\{encodeURIComponent\(id\)\}/g, 'contract-id')
  .replace(/<sha>/g, 'a'.repeat(64))
function routeFor(routes: Route[], method: string, p: string, label: string): Route {
  const route = routes.find(r => r.method === method && r.matches(concretePath(p)))
  expect(route, `${label}: no server route ${method} ${p}`).toBeDefined()
  return route!
}
function fieldsFor(route: Route, fields: string[], label: string): void {
  expect(fields.filter(f => !route.fields.has(f)), `${label}: unknown request fields for ${route.method} ${route.path}`).toEqual([])
}
function objectKeys(obj: ts.ObjectLiteralExpression): string[] {
  return obj.properties.map(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '') .filter(Boolean)
}
function checkValues(obj: ts.ObjectLiteralExpression, label: string): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name) continue
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
    if ((name === 'agent_type' || name === 'severity') && ts.isStringLiteral(prop.initializer)) {
      for (const value of prop.initializer.text.split('|')) {
        if (name === 'agent_type') expect(isExternalEventAllowed(value, {}), `${label}: disallowed agent_type ${value}`).toBe(true)
        else expect(read('src/renderer/src/lib/markerFold.ts').match(/MARKER_SEVERITIES = \[([^\]]+)\]/)?.[1], `${label}: marker severity ${value}`).toContain(`'${value}'`)
      }
    }
  }
}

it('keeps every agent-facing contract copy aligned with the server routes, policy and fields', () => {
  const routes = serverContract()
  expect(routes.length).toBeGreaterThan(30) // a parser that stops seeing routes must fail
  const schema = JSON.parse(read('docs/codex-tools.json')) as { tools: { function: {
    name: string; description?: string; 'x-redlog-requests': { method: string; path: string }[];
    parameters: { properties?: Record<string, { enum?: string[] }> }
  } }[] }
  const tools = new Map(schema.tools.map(t => [t.function.name, t.function]))
  for (const { function: f } of schema.tools) {
    expect(f['x-redlog-requests']?.length, f.name).toBeGreaterThan(0)
    const targets = f['x-redlog-requests'].map(r => routeFor(routes, r.method, r.path, f.name))
    for (const key of Object.keys(f.parameters.properties ?? {})) {
      // id is consumed by the documented path template; action=status selects GET.
      expect(targets.some(r => r.fields.has(key)) || (key === 'id' && f['x-redlog-requests'].some(r => r.path.includes(':id'))), `${f.name}: unknown field ${key}`).toBe(true)
    }
    if (f.name === 'redlog_log_event') {
      for (const list of f.description?.matchAll(/Accepted agent_type values: ([^.]+)\./g) ?? []) {
        for (const value of list[1].split(', ')) expect(isExternalEventAllowed(value, {}), `${f.name}: description ${value}`).toBe(true)
      }
      const values = f.parameters.properties?.agent_type.enum
      expect(values?.length).toBeGreaterThan(0)
      for (const value of values!) expect(isExternalEventAllowed(value, {}), `${f.name}: ${value}`).toBe(true)
    }
    for (const value of f.parameters.properties?.severity?.enum ?? []) {
      expect(read('src/renderer/src/lib/markerFold.ts').match(/MARKER_SEVERITIES = \[([^\]]+)\]/)?.[1]).toContain(`'${value}'`)
    }
  }
  for (const name of ['docs/api-reference.md', 'docs/agent-integration.md', 'README.md']) {
    const text = read(name)
    let route: Route | undefined
    let inBody = false
    let count = 0
    const documented = new Set<Route>()
    for (const line of text.split('\n')) {
      const heading = /^####? `([A-Z]+) (\/api\/[^`]+)`/.exec(line)
      if (/^#/.test(line)) { route = undefined; inBody = false }
      if (heading) route = routeFor(routes, heading[1], heading[2], name)
      const table = /^\| ([A-Z/]+) \| `(\/api\/[^`]+)`/.exec(line)
      if (table) {
        for (const method of table[1].split('/')) {
          const rowRoute = routeFor(routes, method, table[2], name)
          documented.add(rowRoute)
          const envelope = /\{ ([a-z_]+[\w?, ]*) \}/.exec(line)
          if (envelope && method === 'POST') fieldsFor(rowRoute, envelope[1].split(',').map(k => k.trim().replace(/\?$/, '')), name)
          fieldsFor(rowRoute, [...line.matchAll(/[?&](\w+)=/g)].map(m => m[1]), name)
          const filter = /filter by ([^)]+)/.exec(line)
          if (filter) fieldsFor(rowRoute, [...filter[1].matchAll(/`(\w+)`/g)].map(m => m[1]), name)
        }
        count++
      }
      if (route && line.startsWith('**Body:**')) {
        inBody = true
        const inline = /\{([^}]+)\}/.exec(line)
        if (inline) fieldsFor(route, inline[1].split(',').map(x => x.trim().split(':')[0].replace(/\?$/, '')), name)
      }
      if (route && inBody) {
        const field = /^\| `([^`]+)` \|/.exec(line)
        if (field) {
          fieldsFor(route, [field[1]], name)
          if (field[1] === 'agent_type') {
            const description = line.split('|').slice(4).join('|')
            for (const value of description.matchAll(/`([a-z_]+)`/g)) expect(isExternalEventAllowed(value[1], {}), `${name}: agent_type ${value[1]}`).toBe(true)
          }
        }
      }
      if (route && line.startsWith('**Query params:**')) {
        fieldsFor(route, [...line.replace(/\([^)]*\)/g, '').matchAll(/`(\w+)`/g)].map(m => m[1]), name)
      }
    }
    for (const example of text.matchAll(/redlog_mark "[^"]*" "[^"]*" "([^"]*)"/g)) {
      expect(read('src/renderer/src/lib/markerFold.ts').match(/MARKER_SEVERITIES = \[([^\]]+)\]/)?.[1], `${name}: shell marker severity`).toContain(`'${example[1]}'`)
    }
    expect(count, `${name}: route table parsed`).toBeGreaterThan(10)
    if (name !== 'README.md') expect(routes.filter(r => !documented.has(r)).map(r => `${r.method} ${r.path}`), `${name}: missing production routes`).toEqual([])
  }
  // JSON bodies and function-call examples: AST looks only at the envelope;
  // data is deliberately free form and must not be mistaken for route fields.
  for (const name of ['docs/skills/redlog-pentest.md', 'docs/agent-integration.md', 'docs/event-schema.md']) {
    const text = read(name)
    let checked = 0
    for (const block of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
      // Stored derived rows are explicitly labelled, never POST examples.
      if (name === 'docs/event-schema.md' && text.slice(Math.max(0, block.index! - 65), block.index).includes('Stored derived row (not an external POST body):')) continue
      const snippet = source('example.ts', block[1])
      walk(snippet, node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith('redlog_')) {
          const f = tools.get(node.expression.text)
          expect(f, `${name}: missing adapter schema ${node.expression.text}`).toBeDefined()
          for (const arg of node.arguments) if (ts.isObjectLiteralExpression(arg)) {
            expect(objectKeys(arg).filter(k => !Object.hasOwn(f!.parameters.properties ?? {}, k)), `${name}: unknown tool field`).toEqual([])
            checkValues(arg, name); checked++
          }
        }
      })
      if (block[1].trim().startsWith('{')) {
        const snippet = source('json.ts', '(' + block[1] + ')')
        walk(snippet, n => {
          if (ts.isObjectLiteralExpression(n) && ts.isParenthesizedExpression(n.parent)) {
            const keys = objectKeys(n)
            const route = keys.includes('agent_type') ? '/api/events' : keys.includes('title') ? '/api/marker' : undefined
            if (route) { fieldsFor(routeFor(routes, 'POST', route, name), keys, name); checkValues(n, name); checked++ }
          }
        })
      }
    }
    expect(checked, `${name}: examples parsed`).toBeGreaterThan(1)
  }
  // CLI request calls and their literal JSON envelopes, including flag mappings.
  const cliFile = source('cli/redlog-cli.js')
  let cliCalls = 0
  walk(cliFile, n => {
    if (!ts.isCallExpression(n) || !['request', 'requestRaw'].includes(n.expression.getText(cliFile))) return
    const [method, url, body] = n.arguments
    if (!method || !url || !ts.isStringLiteral(method)) return
    const p = ts.isStringLiteral(url) ? url.text : ts.isTemplateExpression(url) ? url.head.text + url.templateSpans.map(s => (s.expression.getText(cliFile).startsWith('encodeURIComponent(id)') ? 'contract-id' : '') + s.literal.text).join('') : ''
    expect(p, 'CLI request path parsed').not.toBe('')
    const route = routeFor(routes, method.text, p, 'CLI')
    if (body && ts.isObjectLiteralExpression(body)) fieldsFor(route, objectKeys(body), 'CLI')
    fieldsFor(route, [...p.matchAll(/[?&](\w+)=/g)].map(m => m[1]), 'CLI query')
    let branch: ts.Node | undefined = n
    while (branch && !ts.isCaseClause(branch)) branch = branch.parent
    if (branch) walk(branch, child => {
      if (ts.isCallExpression(child) && child.expression.getText(cliFile) === 'params.set' && ts.isStringLiteral(child.arguments[0])) {
        fieldsFor(route, [child.arguments[0].text], 'CLI URLSearchParams')
      }
    })
    cliCalls++
  })
  expect(cliCalls).toBeGreaterThan(20)
  const help = read('cli/redlog-cli.js').split('Usage:\n')[1].split('Credentials:')[0]
  expect(help).toContain('info|important|critical')
  const commands = new Set([...read('cli/redlog-cli.js').matchAll(/case '([^']+)':/g)].map(m => m[1]))
  for (const m of help.matchAll(/redlog-cli (\w+)/g)) expect(commands.has(m[1]), `CLI help command ${m[1]}`).toBe(true)
  expect(help).not.toMatch(/info\|low|REDLOG_TOKEN|REDLOG_PORT/)
  // Shell calls contain quoted endpoint strings and escaped JSON envelopes.
  const shell = read('shell/redlog-agent.sh')
  let shellCalls = 0
  for (const m of shell.matchAll(/_redlog_(post|get) "(\/api\/[^"?]+)[^"]*"([^]*?)(?=\n})/g)) {
    const route = routeFor(routes, m[1] === 'post' ? 'POST' : 'GET', m[2], 'shell')
    fieldsFor(route, [...m[3].matchAll(/\\"(\w+)\\":/g)].map(k => k[1]), 'shell')
    fieldsFor(route, [...m[0].matchAll(/[?&](\w+)=/g)].map(k => k[1]), 'shell query')
    shellCalls++
  }
  expect(shellCalls).toBeGreaterThan(8)
  for (const name of ['examples/plugins/recon-pack/hooks/acme-wrapper.sh', 'examples/plugins/codex-hook/hooks/codex-hook.sh']) {
    const text = read(name)
    const values = [...text.matchAll(/"agent_type": "([^"]+)"/g)]
    expect(values.length, `${name}: event envelope parsed`).toBeGreaterThan(0)
    for (const m of values) expect(isExternalEventAllowed(m[1], {}), `${name}: ${m[1]}`).toBe(true)
    for (const m of text.matchAll(/curl[^\n]*-X (\w+)[^\n]*?(\/api\/[^"?\s]+)/g)) routeFor(routes, m[1], m[2], name)
  }
  for (const name of ['docs/skills/redlog-pentest.md', 'docs/agent-integration.md']) {
    expect(read(name)).not.toMatch(/claude_code_bash|The hook already logs it|Settings ▸ Hooks|Settings ▸ Operator Tokens so/)
  }
})

it('shell helper preserves successful bodies and reports transport failures', () => {
  const script = `source "$1"
    _redlog_curl_authed() { printf '%s\\n201' '{"id":"created"}'; }
    redlog_event agent '{}'
    _redlog_curl_authed() { printf 'connection refused\\n' >&2; return 7; }
    redlog_scope`
  const res = spawnSync('bash', ['-c', script, 'contract', path.join(root, 'shell/redlog-agent.sh')], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home }
  })
  expect(res.status).toBe(7)
  expect(res.stdout).toBe('{"id":"created"}\n')
  expect(res.stderr).toBe('connection refused\n[redlog] transport failed (curl 7)\n')
})
it('redlog-cli failed screenshot preserves the server message even with HTTP 200', () => {
  const res = cli(['screenshot'], 200, '{"captured":false,"error":"screen permission denied"}')
  expect(res.status).toBe(1)
  expect(res.stderr).toBe('screen permission denied\n')
})
