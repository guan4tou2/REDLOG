// Spec 072 T002 — what the writers write TODAY.
//
// This is a measuring instrument, not a registry. It answers one question from
// the source text alone: which (agent_type, subtype) pairs can a RedLog writer
// put in the record, and where. T003 builds example rows from it, T004 feeds
// those rows to today's tables, T010 pins today's tier for each pair, and
// Phase 2's `writers-registered.test.ts` will compare it with the registry.
//
// Two scans, as plan D2 says, because the writers speak different languages:
//
//   1. TypeScript (src/, optional-plugins/) — TypeScript AST. A call to
//      insertEvent / ingestEvent / ingest is a writer; the subtype is read from
//      the `subtype` property of the data argument. A subtype that is held in
//      a variable is resolved to the string literals assigned to it inside the
//      same function (cdp-connector's `subtype = level === 'error' ? … : …`).
//      What cannot be resolved is reported as a DYNAMIC site with file:line,
//      never dropped: that is the "half of `system` goes through variables"
//      finding of the spec.
//   2. Everything else (hooks/, plugins/) — text patterns per language, with
//      the agent_type taken from FILE_AGENT_TYPES. A file that matches a
//      pattern and is not in that table is returned in `undeclared`, so a new
//      writer must declare itself.
//
// DYNAMIC sites are then answered by ANNOTATED, a reviewed list. Each entry
// names a file and a `needle` that must still be in that file; an entry whose
// needle is gone is `stale` and the test fails. That keeps the list from
// drifting into a second, unchecked table.
//
// Known blind spots (each has a negative assertion in inventory.test.ts):
//   - a shell call that builds the subtype in a variable (`_redlog_send_event "$x"`);
//   - Python events assembled with `dict(**kw)`;
//   - a plugin that makes its subtype from a dynamic string;
//   - `redlog-cli log <agent_type> --data '{…}'` and the local API: an external
//     caller can write any subtype; that is the `external:*` / `terminal:*`
//     family question, not an inventory question.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import glob from 'fast-glob'

export interface WriterHit {
  agentType: string
  /** '' when the writer sends no subtype (screenshot, marker). */
  subtype: string
  file: string
  line: number
  via: 'ts-call' | 'ts-resolved' | 'annotated' | 'sh' | 'zsh' | 'ps1' | 'py' | 'js'
}

export interface DynamicSite {
  file: string
  line: number
  /** The source line, trimmed, so an answer can say which site it means. */
  text: string
  agentType: string | null
  reason: string
}

export interface Inventory {
  hits: WriterHit[]
  /** TypeScript call sites whose subtype or agent_type could not be read. */
  dynamic: DynamicSite[]
  /** Dynamic sites no ANNOTATED entry accounts for. */
  unannotated: DynamicSite[]
  /** ANNOTATED entries whose needle is no longer in the file. */
  stale: string[]
  /** Files outside TypeScript that matched a pattern but are not in FILE_AGENT_TYPES. */
  undeclared: string[]
}

const WRITE_CALLEES = new Set(['insertEvent', 'ingestEvent', 'ingest'])

/** The agent_type(s) each non-TypeScript writer file writes (plan D2). */
export const FILE_AGENT_TYPES: Record<string, string[]> = {
  'hooks/shell-common.sh': ['shell'],
  'hooks/shell-zsh-hook.zsh': ['shell'],
  'hooks/shell-bash-hook.sh': ['shell'],
  'hooks/shell-hook.ps1': ['shell'],
  'hooks/wsl-redlog-test.sh': ['shell'],
  'hooks/redlog-session.py': ['shell'],
  'hooks/redlog-relay.py': ['shell'],
  'hooks/mitmproxy-addon.py': ['scanner', 'dns'],
  'hooks/pcap-agent.py': ['pcap'],
  'plugins/c2-tailers/parse.js': ['scanner'],
  'plugins/pcap-capture/pcap-parse.js': ['scanner'],
  'plugins/pcap-capture/pcap-sidecar.js': ['scanner'],
  'plugins/pcap-capture/pcap-capture.js': ['scanner', 'system']
}

/** Files that were looked at and write nothing of their own (so a match is not a writer). */
export const FOREIGN_NOT_WRITERS = new Set<string>([
  // posts a caller-supplied subtype: `redlog-send.sh <subtype> …` / `-Subtype $x`.
  // Its callers are not in the repository; it is a blind spot, not a writer.
  'hooks/redlog-send.sh',
  'hooks/redlog-send.ps1',
])

function agentTypeFor(file: string, subtype: string): string | null {
  const types = FILE_AGENT_TYPES[file]
  if (!types) return null
  if (types.length === 1) return types[0]
  if (file === 'hooks/mitmproxy-addon.py') return subtype.startsWith('dns_') ? 'dns' : 'scanner'
  if (file === 'plugins/pcap-capture/pcap-capture.js') return subtype === 'producer_heartbeat' ? 'system' : 'scanner'
  return types[0]
}

// ── TypeScript ──────────────────────────────────────────────────────────────

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function lineText(sf: ts.SourceFile, node: ts.Node): string {
  return sf.text.split(/\r?\n/)[lineOf(sf, node) - 1].trim()
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text
  return null
}

function enclosingFunction(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)
      || ts.isMethodDeclaration(cur)) return cur
    cur = cur.parent
  }
  return node.getSourceFile()
}

/** String literals an expression can evaluate to, or null if any leaf is not a literal. */
function literals(expr: ts.Expression): string[] | null {
  if (ts.isStringLiteralLike(expr)) return [expr.text]
  if (ts.isParenthesizedExpression(expr)) return literals(expr.expression)
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return literals(expr.expression)
  if (ts.isConditionalExpression(expr)) {
    const a = literals(expr.whenTrue)
    const b = literals(expr.whenFalse)
    return a && b ? [...a, ...b] : null
  }
  return null
}

/** Every right-hand side assigned to `name` inside `scope`. */
function assignmentsTo(scope: ts.Node, name: string): ts.Expression[] {
  const out: ts.Expression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) out.push(n.initializer)
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(n.left) && n.left.text === name) out.push(n.right)
    ts.forEachChild(n, visit)
  }
  visit(scope)
  return out
}

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

function fnName(fn: FnLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text
  const p = fn.parent
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  return null
}

function isFn(n: ts.Node): n is FnLike {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
}

/** `name` as a parameter of `scope`, with the call-site arguments a wrapper receives. */
function parameterOf(scope: ts.Node, name: string): { index: number; type: ts.TypeNode | undefined; fn: FnLike } | null {
  if (!isFn(scope)) return null
  const index = scope.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name)
  return index < 0 ? null : { index, type: scope.parameters[index].type, fn: scope }
}

function literalType(t: ts.TypeNode | undefined): string[] | null {
  if (!t) return null
  if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) return [t.literal.text]
  if (ts.isUnionTypeNode(t)) {
    const out: string[] = []
    for (const m of t.types) {
      const l = literalType(m)
      if (!l) return null
      out.push(...l)
    }
    return out
  }
  return null
}

/** Arguments every same-file call of the wrapper passes at `index`. */
function callArguments(sf: ts.SourceFile, name: string, index: number): ts.Expression[] {
  const out: ts.Expression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && n.arguments[index]) out.push(n.arguments[index])
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The object literals a data argument stands for, or null when it cannot be seen. */
function dataObjects(arg: ts.Expression, scope: ts.Node): ts.ObjectLiteralExpression[] | null {
  if (ts.isObjectLiteralExpression(arg)) return [arg]
  // redactFields({…}) and the like: a call whose first argument is the literal.
  if (ts.isCallExpression(arg) && arg.arguments[0]) return dataObjects(arg.arguments[0], scope)
  if (ts.isIdentifier(arg)) {
    // A wrapper: `function write(data) { insertEvent('system', data) }` stands for
    // what its same-file callers pass.
    const param = parameterOf(scope, arg.text)
    if (param) {
      const name = fnName(param.fn)
      if (!name) return null
      const callers = callArguments(scope.getSourceFile(), name, param.index)
      const objs: ts.ObjectLiteralExpression[] = []
      for (const c of callers) {
        const found = dataObjects(c, enclosingFunction(c))
        if (!found) return null
        objs.push(...found)
      }
      return objs.length ? objs : null
    }
    const objs: ts.ObjectLiteralExpression[] = []
    for (const rhs of assignmentsTo(scope, arg.text)) {
      const found = dataObjects(rhs, scope)
      if (!found) return null
      objs.push(...found)
    }
    return objs.length ? objs : null
  }
  return null
}

interface Resolved { subtypes: string[]; reason: string | null }

function subtypesOf(obj: ts.ObjectLiteralExpression, scope: ts.Node): Resolved {
  let sawSubtype = false
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return { subtypes: [], reason: 'spread in data' }
    const name = propName(p)
    if (name !== 'subtype') continue
    sawSubtype = true
    if (ts.isShorthandPropertyAssignment(p)) {
      const param = parameterOf(scope, 'subtype')
      const typed = param ? literalType(param.type) : null
      if (typed) return { subtypes: typed, reason: null }
      const rhs = assignmentsTo(scope, 'subtype')
      const all: string[] = []
      for (const r of rhs) {
        const lit = literals(r)
        if (!lit) return { subtypes: [], reason: 'subtype variable has a non-literal assignment' }
        all.push(...lit)
      }
      // `let subtype = ''` is the initial value, not a kind.
      const real = all.filter((s) => s !== '')
      return real.length ? { subtypes: real, reason: null } : { subtypes: [], reason: 'subtype variable never assigned a literal' }
    }
    if (ts.isPropertyAssignment(p)) {
      const lit = literals(p.initializer)
      if (lit) return { subtypes: lit, reason: null }
      if (ts.isIdentifier(p.initializer)) {
        const param = parameterOf(scope, p.initializer.text)
        const typed = param ? literalType(param.type) : null
        if (typed) return { subtypes: typed, reason: null }
        const all: string[] = []
        for (const r of assignmentsTo(scope, p.initializer.text)) {
          const l = literals(r)
          if (!l) return { subtypes: [], reason: `subtype built from ${p.initializer.text}` }
          all.push(...l)
        }
        const real = all.filter((s) => s !== '')
        if (real.length) return { subtypes: real, reason: null }
      }
      return { subtypes: [], reason: 'subtype is an expression' }
    }
  }
  return sawSubtype ? { subtypes: [], reason: 'subtype unreadable' } : { subtypes: [''], reason: null }
}

function scanTypeScript(root: string, hits: WriterHit[], dynamic: DynamicSite[]): void {
  const files = glob.sync(['src/**/*.{ts,tsx}', 'optional-plugins/**/*.ts'], { cwd: root, absolute: true, ignore: ['**/*.d.ts'] })
  for (const abs of files.sort()) {
    const file = path.relative(root, abs).split(path.sep).join('/')
    const text = fs.readFileSync(abs, 'utf8')
    if (!/\b(insertEvent|ingestEvent|ingest)\s*\(/.test(text)) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && WRITE_CALLEES.has(n.expression.text)
        && !isDeclarationSite(n)) readCall(n)
      ts.forEachChild(n, visit)
    }
    const readCall = (call: ts.CallExpression): void => {
      const line = lineOf(sf, call)
      const scope = enclosingFunction(call)
      const callee = (call.expression as ts.Identifier).text
      let agentExpr: ts.Expression | undefined
      let dataExpr: ts.Expression | undefined
      if (callee === 'ingest') {
        const a = call.arguments[0]
        if (a && ts.isObjectLiteralExpression(a)) {
          for (const p of a.properties) {
            if (ts.isPropertyAssignment(p) && propName(p) === 'agentType') agentExpr = p.initializer
            else if (ts.isShorthandPropertyAssignment(p) && propName(p) === 'agentType') agentExpr = p.name
            if (ts.isPropertyAssignment(p) && propName(p) === 'data') dataExpr = p.initializer
            else if (ts.isShorthandPropertyAssignment(p) && propName(p) === 'data') dataExpr = p.name
          }
        }
      } else {
        agentExpr = call.arguments[0]
        dataExpr = call.arguments[1]
      }
      const agentLits = agentExpr ? literals(agentExpr) : null
      if (!agentLits || !dataExpr) {
        dynamic.push({ file, line, text: lineText(sf, call), agentType: null, reason: 'agent_type is not a literal' })
        return
      }
      const objs = dataObjects(dataExpr, scope)
      if (!objs) {
        for (const agentType of agentLits) dynamic.push({ file, line, text: lineText(sf, call), agentType, reason: 'data is not an object literal' })
        return
      }
      for (const obj of objs) {
        const r = subtypesOf(obj, scope)
        for (const agentType of agentLits) {
          if (r.reason) dynamic.push({ file, line, text: lineText(sf, call), agentType, reason: r.reason })
          for (const subtype of r.subtypes) {
            hits.push({ agentType, subtype, file, line, via: dataExpr === obj || ts.isObjectLiteralExpression(dataExpr) || ts.isCallExpression(dataExpr) ? 'ts-call' : 'ts-resolved' })
          }
        }
      }
    }
    visit(sf)
  }
}

/** `function insertEvent(` and `export function ingest(` are not calls; their call expressions are not either. */
function isDeclarationSite(call: ts.CallExpression): boolean {
  return ts.isFunctionDeclaration(call.parent)
}

// ── Reviewed answers for the dynamic sites ──────────────────────────────────

export interface Annotation {
  /** The dynamic call site (its file) this entry answers. */
  site: string
  /** Where the answer is written; defaults to `site`. */
  file?: string
  agentType: string
  /** subtype -> a string that must still be in `file`. '' means "no subtype". */
  subtypes: Record<string, string>
}

/** Doors that forward whatever their caller hands them; they are not writers of a kind. */
export const FORWARDERS: Record<string, string> = {
  'src/core/api-server.ts': 'POST /api/ingest: the external door; the agent_type is the caller\'s (external-event-policy)',
  'src/core/spool-drain.ts': 'replays a spooled payload some other writer produced; the kind belongs to that writer',
}

/** The pipeline entry itself: `ingestEvent` wraps `ingest`, `ingest` wraps `insertEvent`. */
const DOOR_TEXT = ['return ingest({ agentType, data, ...opts }).event', 'const event = insertEvent(agentType, data, {']

/**
 * Kinds the AST cannot read, from reading the code beside each dynamic site.
 * Add an entry when `unannotated` names a new site; delete it when `stale` does.
 * Every subtype carries the text that proves it is still there.
 */
export const ANNOTATED: Annotation[] = [
  { site: 'src/core/alert/surface.ts', agentType: 'system', subtypes: {
    ip_verdict: "subtype: 'ip_verdict'", scope_violation: 'subtype: SCOPE_VIOLATION_SUBTYPE' } },
  { site: 'src/core/scope-recompute-run.ts', agentType: 'system', subtypes: { scope_violation: 'subtype: SCOPE_VIOLATION_SUBTYPE' } },
  { site: 'src/core/retention.ts', agentType: 'system', subtypes: {
    cast_pruned: "'cast_pruned',\n", screenshot_pruned: "'screenshot_pruned',\n",
    agent_transcript_pruned: "'agent_transcript_pruned',\n", http_body_pruned: "'http_body_pruned',\n" } },
  { site: 'src/core/bundle-export.ts', agentType: 'system', subtypes: { export_sealed: 'subtype: SEAL_SUBTYPE' } },
  { site: 'src/main/index.ts', agentType: 'system', subtypes: {
    recording_paused: "'recording_paused' as const", recording_resumed: "'recording_resumed' as const" } },
  { site: 'src/main/index.ts', file: 'src/core/unsaved-gap.ts', agentType: 'system', subtypes: { capture_gap: "subtype: 'capture_gap'" } },
  { site: 'src/main/services/cdp-connector.ts', agentType: 'browser', subtypes: {
    console_warn: "'console_warn'", console_error: "'console_error'", console_info: "'console_info'",
    console_debug: "'console_debug'", console_trace: "'console_trace'", console_log: "'console_log'",
    exception: "subtype = 'exception'", log_entry: "subtype = 'log_entry'" } },
  { site: 'src/main/ipc/markers.ts', agentType: 'marker', subtypes: { '': "ingestEvent('marker'" } },
  { site: 'src/main/services/screenshot-agent.ts', agentType: 'screenshot', subtypes: { '': "ingestEvent('screenshot'" } },
  // tailer-host forwards what the adapters' `subtypeFor` returns.
  { site: 'src/main/services/tailer-host.ts', file: 'optional-plugins/claude-code/adapter.ts', agentType: 'agent', subtypes: {
    user_message: "'user_message'", assistant_message: "'assistant_message'", thinking: "'thinking'", tool_call: "'tool_call'",
    tool_result: "'tool_result'", tool_interrupted: "'tool_interrupted'", compact_summary: "'compact_summary'",
    away_summary: "'away_summary'", model_refusal: "'model_refusal'", api_error: "'api_error'" } },
  // The companions ingest.ts writes for a command or request it just recorded.
  { site: 'src/core/ingest.ts', file: 'src/core/pivot-detector.ts', agentType: 'pivot', subtypes: {
    agent_connect: "subtype: 'agent_connect'", tunnel_start: "subtype: 'tunnel_start'", socks_up: "subtype: 'socks_up'",
    port_forward: "subtype: 'port_forward'", route_add: "subtype: 'route_add'", proxied: "subtype: 'proxied'",
    interactive: "subtype: 'interactive'" } },
  { site: 'src/core/ingest.ts', agentType: 'pivot', subtypes: { closed: "subtype: 'closed'" } },
  { site: 'src/core/ingest.ts', file: 'src/core/technique-tagger.ts', agentType: 'cleanup', subtypes: {
    log_clear: "subtype: 'log_clear'", history_clear: "subtype: 'history_clear'", file_shred: "subtype: 'file_shred'",
    timestomp: "subtype: 'timestomp'", attr_hide: "subtype: 'attr_hide'" } },
  { site: 'src/core/ingest.ts', file: 'src/core/technique-tagger.ts', agentType: 'file_transfer', subtypes: {
    download: "direction: 'download'", upload: "direction: 'upload'" } },
  { site: 'src/core/ingest.ts', agentType: 'credential_use', subtypes: {
    basic_auth: "method: 'basic_auth'", bearer_token: "method: 'bearer_token'", ntlm: "method: 'ntlm'",
    negotiate: "method: 'negotiate'", digest: "method: 'digest'", session_cookie: "method: 'session_cookie'",
    api_key: "method: 'api_key'", form_login: "method: 'form_login'" } },
  { site: 'src/core/ingest.ts', file: 'src/core/credential-detector.ts', agentType: 'credential_use', subtypes: {
    password_flag: "kind: 'password_flag'", url_userinfo: "kind: 'url_userinfo'", auth_header: "kind: 'auth_header'" } }
]

// ── everything that is not TypeScript ───────────────────────────────────────

interface Pattern { re: RegExp; via: WriterHit['via'] }
const PATTERNS: Array<{ glob: string; patterns: Pattern[] }> = [
  { glob: 'hooks/*.sh', patterns: [
    { re: /_redlog_send_event\s+"([a-z0-9_]+)"/g, via: 'sh' },
    { re: /\\?"subtype\\?"\s*:\s*\\?"([a-z0-9_]+)\\?"/g, via: 'sh' }
  ] },
  { glob: 'hooks/*.zsh', patterns: [{ re: /_redlog_send_event\s+"([a-z0-9_]+)"/g, via: 'zsh' }] },
  { glob: 'hooks/*.ps1', patterns: [
    { re: /-Subtype\s+'([a-z0-9_]+)'/g, via: 'ps1' },
    { re: /\bsubtype\s*=\s*'([a-z0-9_]+)'/g, via: 'ps1' }
  ] },
  { glob: 'hooks/*.py', patterns: [
    { re: /["']subtype["']\s*:\s*["']([a-z0-9_]+)["']/g, via: 'py' },
    { re: /\b_emit\(\s*["']([a-z0-9_]+)["']/g, via: 'py' }
  ] },
  { glob: 'plugins/**/*.js', patterns: [
    { re: /\bsubtype\s*:\s*'([a-z0-9_]+)'/g, via: 'js' },
    { re: /\bpost\(\s*\{\s*subtype:\s*'([a-z0-9_]+)'/g, via: 'js' }
  ] }
]

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('#') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function scanForeign(root: string, hits: WriterHit[], undeclared: string[]): void {
  const seenUndeclared = new Set<string>()
  for (const { glob: g, patterns } of PATTERNS) {
    for (const abs of glob.sync(g, { cwd: root, absolute: true, ignore: ['**/node_modules/**'] }).sort()) {
      const file = path.relative(root, abs).split(path.sep).join('/')
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
      lines.forEach((text, i) => {
        if (isComment(text)) return
        for (const { re, via } of patterns) {
          for (const m of text.matchAll(re)) {
            if (FOREIGN_NOT_WRITERS.has(file)) continue
            const agentType = agentTypeFor(file, m[1])
            if (!agentType) {
              if (!seenUndeclared.has(file)) { seenUndeclared.add(file); undeclared.push(file) }
              continue
            }
            hits.push({ agentType, subtype: m[1], file, line: i + 1, via })
          }
        }
      })
    }
  }
}

export function scanInventory(root: string): Inventory {
  const hits: WriterHit[] = []
  const dynamic: DynamicSite[] = []
  const undeclared: string[] = []
  scanTypeScript(root, hits, dynamic)
  scanForeign(root, hits, undeclared)

  const stale: string[] = []
  const answered = new Set<string>()
  for (const a of ANNOTATED) {
    const file = a.file ?? a.site
    const abs = path.join(root, file)
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
    for (const [subtype, needle] of Object.entries(a.subtypes)) {
      const idx = text.indexOf(needle)
      if (idx < 0) { stale.push(`${file}: ${JSON.stringify(needle)} (${a.agentType}:${subtype || '-'})`); continue }
      const line = text.slice(0, idx).split('\n').length
      hits.push({ agentType: a.agentType, subtype, file, line, via: 'annotated' })
    }
    answered.add(`${a.site}|${a.agentType}`)
  }
  const unannotated = dynamic.filter((d) => {
    if (FORWARDERS[d.file]) return false
    if (d.file === 'src/core/ingest.ts' && DOOR_TEXT.some((t) => d.text.startsWith(t))) return false
    if (d.agentType === null) return !ANNOTATED.some((a) => a.site === d.file)
    return !answered.has(`${d.file}|${d.agentType}`)
  })
  return { hits, dynamic, unannotated, stale, undeclared }
}

/** Distinct `agentType:subtype` ids (a bare agent_type when there is no subtype). */
export function kindIds(hits: readonly WriterHit[]): string[] {
  return [...new Set(hits.map((h) => (h.subtype ? `${h.agentType}:${h.subtype}` : h.agentType)))].sort()
}
