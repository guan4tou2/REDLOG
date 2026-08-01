// OpenCode ▸ RedLog capture plugin.
//
// Docs: https://opencode.ai/docs/plugins/ (verified 2026-08 — the `Plugin`
// export shape, the `tool.execute.after` hook, and the plugin-directory
// auto-load semantics all match what's live at that URL).
//
// Wire flow:
//   1. OpenCode auto-loads any .mjs / .ts file dropped into either
//        .opencode/plugins/          (project-scoped)
//        ~/.config/opencode/plugins/ (global)
//      and calls each `export default` plugin's async factory at startup.
//   2. We return `{ 'tool.execute.after': async (input, output) => … }`.
//      After every tool call OpenCode fires this with the tool name +
//      input args + output.
//   3. The hook POSTs a `redlog agent` event to the local RedLog API.
//
// Design intent — MIRRORS the shape of examples/plugins/codex-hook/hooks/
// codex-hook.sh so the timeline treats Codex + OpenCode events uniformly.
// Written as .mjs (not .ts) so operators without a TypeScript build step
// can drop it in directly.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// ---- Small, silent readers ------------------------------------------------

function readSilent(p) {
  try { return fs.readFileSync(p, 'utf8').trim() } catch { return '' }
}

function loadHookConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.redlog/hook-config.json'), 'utf8'))
  } catch { return {} }
}

function cwdExcluded(cwd, excludedPaths) {
  if (!Array.isArray(excludedPaths) || excludedPaths.length === 0) return false
  const home = os.homedir()
  const norm = (s) => s.replace(/^~/, home)
  return excludedPaths.some((ep) => {
    if (!ep) return false
    const e = path.resolve(norm(ep))
    return cwd === e || cwd.startsWith(e + path.sep)
  })
}

// Sync-friendly redaction — mirrors the sed block in claude-code-hook.sh so
// secrets don't leak into the event payload. Keep the patterns broad; the
// downstream loot detector does the real work.
const SECRET_PATTERNS = [
  /(?:sk-[A-Za-z0-9]{20,})/g,                 // OpenAI / Anthropic-style
  /(?:ghp_[A-Za-z0-9]{20,})/g,                // GitHub PAT
  /(?:AKIA[0-9A-Z]{16})/g,                    // AWS access key id
  /(?:xox[baprs]-[A-Za-z0-9-]{10,})/g,        // Slack tokens
  /(?:Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,   // Bearer headers
  /(?:password|passwd|secret|token|api_key)\s*[:=]\s*["']?[^\s"']{4,}/gi
]

function redact(s) {
  if (typeof s !== 'string') return s
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, '<REDACTED>')
  return out
}

// ---- Local HTTP → RedLog --------------------------------------------------

function postEvent(port, token, body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => { res.resume(); res.on('end', resolve) })
    req.on('error', () => resolve())          // never propagate — capture is best-effort
    req.setTimeout(1500, () => { req.destroy(); resolve() })
    req.write(body); req.end()
  })
}

async function isRecording(port, token) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/recording', method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, (res) => {
      let raw = ''
      res.on('data', (c) => raw += c)
      res.on('end', () => {
        try { resolve(JSON.parse(raw)?.recording !== false) } catch { resolve(true) }
      })
    })
    req.on('error', () => resolve(false))
    req.setTimeout(800, () => { req.destroy(); resolve(false) })
    req.end()
  })
}

// ---- The Plugin -----------------------------------------------------------

export default async ({ directory }) => {
  const port = Number(readSilent(path.join(os.homedir(), '.redlog/api-port')))
  const token = readSilent(path.join(os.homedir(), '.redlog/api-token'))
  const hookConfig = loadHookConfig()
  const excludedPaths = hookConfig.excludedPaths || []

  // If RedLog isn't running (no token/port on disk), silently no-op every
  // hook — same behaviour as the shell hooks. Never break the operator's
  // OpenCode session because RedLog is closed.
  if (!port || !token) {
    return { 'tool.execute.after': async () => {} }
  }

  return {
    // Fires AFTER every tool call. `input` = { tool, sessionID, callID },
    // `output` = { args, title, metadata, output } based on the docs.
    // Defensive on every field — the shape isn't strictly frozen yet.
    'tool.execute.after': async (input, output) => {
      try {
        if (cwdExcluded(directory || process.cwd(), excludedPaths)) return
        if (!(await isRecording(port, token))) return

        const toolName = input?.tool ?? 'unknown'
        const sessionId = input?.sessionID ?? null
        const args = output?.args ?? output?.input ?? {}
        // Some tools return the actual result under `.output`, others under
        // `.metadata.output`. Try both, cap to 500 chars, redact.
        const raw = output?.output ?? output?.metadata?.output ?? ''
        const preview = redact(String(raw).slice(0, 500))

        const body = JSON.stringify({
          agent_type: 'agent',
          data: {
            subtype: 'opencode_tool',
            tool: toolName,
            tool_input: args,
            output_preview: preview,
            session_id: sessionId,
            cwd: directory || process.cwd(),
            source: 'opencode-plugin'
          }
        })
        await postEvent(port, token, body)
      } catch {
        // Never throw from a hook — OpenCode would surface it as a plugin
        // error and interrupt the operator's session.
      }
    }
  }
}
