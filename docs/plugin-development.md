# RedLog Plugin Development

RedLog is extensible through **plugins** — directories with a `plugin.json`
manifest that add capture integrations, detection rules, event types, and (when
you trust them) agent-operable tools. This guide covers the manifest format,
every contribution type, the code contract for privileged plugins, and the
trust/security model that keeps an audit tool from running code it shouldn't.

- [Trust tiers (read this first)](#trust-tiers)
- [Plugin layout](#plugin-layout)
- [Manifest reference](#manifest-reference)
- [🟢 Declarative contributions](#-declarative-contributions)
- [🔴 Privileged code contributions](#-privileged-code-contributions)
- [The trust gate](#the-trust-gate)
- [Installing & managing plugins](#installing--managing-plugins)
- [What can be a plugin (and what can't yet)](#what-can-be-a-plugin)

---

## Trust tiers

RedLog's whole job is to produce a **tamper-evident** record of an engagement.
So plugins are split by how much they can affect that record:

| Tier | What it contributes | Runs code in RedLog? | Can it subvert the evidence log? |
|------|--------------------|----------------------|----------------------------------|
| 🟢 **declarative** | loot/redaction/target patterns, event types, capture scripts | **No** — data the app reads, or scripts *you* run that only reach the authenticated HTTP API | No |
| 🔴 **privileged** | MCP tools (and, later, exporters/monitors) | **Yes** — in an isolated process, only after you grant trust | Only within the capabilities you granted |

A plugin is 🔴 **only** if it contributes code (`mcpTools`/`exporters`/`monitors`).
Everything else is 🟢 and loads automatically. 🔴 plugins are inert until you
review and trust them (see [the trust gate](#the-trust-gate)).

---

## Plugin layout

```
my-plugin/
  plugin.json           # required manifest
  hooks/
    capture.sh          # 🟢 capture script (optional)
  code/
    tools.js            # 🔴 CommonJS module (optional)
```

Plugins are discovered from two roots (user overrides bundled by id):

- **User:** `~/.redlog/plugins/<id>/`  ← drop your plugin here
- **Bundled:** `<RedLog resources>/plugins/<id>/` (first-party plugins)

Every path referenced in the manifest must stay **inside** the plugin directory
(no `..`, no absolute paths) and must exist, or the plugin fails to load.

---

## Manifest reference

```jsonc
{
  "id": "my-plugin",            // required — lowercase kebab, 2–64 chars, unique
  "name": "My Plugin",          // required — display name
  "version": "1.0.0",           // required — semver
  "description": "…",           // optional
  "author": "your-handle",      // optional
  "homepage": "https://…",      // optional
  "redlogApi": 1,               // required — plugin API version you target
  "contributes": { … },         // required — see below
  "capabilities": ["…"],        // 🔴 only — what the code needs (least authority)
  "signature": "…",             // optional — reserved for signed publishing
  "publisher": "…"              // optional — reserved
}
```

`redlogApi` is checked against the RedLog build: a plugin targeting a **newer**
API than the host supports is rejected rather than half-loaded. Current API
version: **1**.

---

## 🟢 Declarative contributions

All of these are pure data. They load automatically and can never run code.

### `lootPatterns` — teach the loot detector new secret formats

```jsonc
"lootPatterns": [
  { "type": "acme_session", "pattern": "ACME-[A-Z0-9]{16}", "confidence": "high" },
  { "type": "corp_jwt", "pattern": "corp_eyJ[\\w-]+\\.[\\w-]+", "confidence": "medium", "flags": "i" }
]
```

`pattern` is a JS RegExp source (the `g` flag is always applied; add others via
`flags`). Matches surface as `loot` events, exactly like the built-in patterns.
Invalid regexes are skipped, not fatal.

### `redaction` — add allow/deny entries

```jsonc
"redaction": {
  "denylist": ["/CORP_[A-Z0-9]{20,}/"],   // /…/ = regex, otherwise substring
  "allowlist": ["example.com"]
}
```

Merged **additively** on top of the engagement's redaction rules; removed when
the plugin is disabled.

### `targetExtractors` — pull targets from bespoke tooling

```jsonc
"targetExtractors": [
  { "cmd": "^acme-scan\\s", "extract": "--target\\s+(\\S+)" }
]
```

For a command matching `cmd`, capture group 1 of `extract` (or the whole match)
becomes the target. **Plugin extractors take precedence** over the built-ins, so
you can teach RedLog about tools it doesn't ship knowledge of.

### `eventTypes` — give a new `agent_type` a timeline identity

```jsonc
"eventTypes": [
  { "agentType": "acme_scan", "label": "ACME Scan", "lane": "scanner", "color": "#7c3aed", "icon": "🔭" }
]
```

Pure rendering metadata — it never changes how events are recorded or chained.

### `capture` — a capture integration (like the built-in hooks)

```jsonc
"capture": [
  {
    "id": "acme-cli",
    "name": "ACME CLI",
    "description": "Capture commands run through acme-cli",
    "agentType": "shell",
    "requires": ["acme-cli"],           // any-of; used for availability detection
    "hookFile": "hooks/acme-wrapper.sh",
    "installMethod": "manual",          // 'shell-source' | 'claude-settings' | 'manual'
    "manualSteps": [
      { "label": "Wrap the CLI so RedLog captures each call", "command": "\"{hookFile}\" --help" }
    ]
  }
]
```

Capture entries appear in **Settings ▸ Hooks** alongside the built-ins, with the
same one-click install (`shell-source`/`claude-settings`) or guided steps
(`manual`). Use the `{hookFile}` placeholder in `manualSteps` — RedLog fills in
the absolute path. The capture id is namespaced as `<plugin-id>.<id>`.

A capture script only records **while RedLog is open** — it reads
`~/.redlog/api-port` and `~/.redlog/api-token` and POSTs to the local API. It is
out-of-process and unprivileged: it can append events like any API client, but
can't touch existing events or the chain. See
[`examples/plugins/recon-pack`](../examples/plugins/recon-pack) for a full one.

---

## 🔴 Privileged code contributions

A plugin that sets `mcpTools` (a manifest-relative CommonJS module path) ships
code RedLog will execute — **in an isolated Electron utility process**, never in
the main process, and only after you grant trust. It must declare the
`capabilities` it needs.

### The module contract

```js
// code/tools.js
module.exports = {
  register(ctx) {
    return {
      tools: [
        {
          name: 'geolocate',
          description: 'Geolocate an IPv4 and log the lookup.',
          inputSchema: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] },
          async run(args) {
            const resp = await ctx.fetch({ url: `https://ipapi.co/${args.ip}/json/` })   // net:outbound
            const geo = JSON.parse(resp.body)
            await ctx.events.append({ agent_type: 'agent', data: { subtype: 'geoip', ip: args.ip, city: geo.city } }) // write:events
            return { ip: args.ip, city: geo.city }
          }
        }
      ]
    }
  }
}
```

Tools are exposed over RedLog's built-in MCP server, name-spaced to the plugin
(`geoip_tool_geolocate`), so any connected agent can call them. `run()` executes
in the isolated process; its return value is sent back as the tool result.

### The `ctx` API and capabilities

`ctx` is the **only** way plugin code reaches RedLog. Every method is gated by a
capability declared in the manifest and granted by the operator:

| `ctx` method | Capability | Does |
|--------------|-----------|------|
| `ctx.events.query(args)` | `read:events` | query the timeline |
| `ctx.events.search(args)` | `read:events` | keyword search |
| `ctx.events.append(args)` | `write:events` | append an event (attributed to the plugin) |
| `ctx.findings.list(args)` | `read:findings` | read loot/quickmarks |
| `ctx.config.get()` | `read:config` | read engagement/scope/redaction config |
| `ctx.fetch(args)` | `net:outbound` | outbound HTTP (⚠️ exfil surface) |
| `ctx.log(msg)` | — | write to RedLog's log |

A call to a method whose capability wasn't granted is **rejected** at the host —
the plugin can't escalate by asking. The isolated process has **no** direct
access to the SQLite database, the signing keys, or the main process.

See [`examples/plugins/geoip-tool`](../examples/plugins/geoip-tool).

> `exporters` and `monitors` are reserved in the manifest for the same isolated,
> capability-scoped mechanism and are on the roadmap; only `mcpTools` executes
> today.

---

## The trust gate

🔴 plugins are governed by a content-hash-pinned consent record
(`~/.redlog/plugins/trust.json`):

1. On load, RedLog computes a **content hash** over the manifest (id, version,
   contributes, capabilities) plus every code file it references.
2. A 🔴 plugin shows as **NEEDS CONSENT** until you review it in
   **Settings ▸ Plugins** and click **Review & trust**. The dialog lists the
   exact capabilities requested.
3. Granting pins the current hash + capabilities.
4. If the code or requested capabilities later change, the hash no longer
   matches → trust is automatically revoked and the plugin returns to
   **CODE CHANGED / NEEDS CONSENT** until you review again.
5. **Revoke trust** at any time; the isolated process is killed and its tools
   disappear from MCP.

This means: shipping new code, or a manifest asking for more power, can never
silently gain execution — a human re-approves every material change.

---

## Installing & managing plugins

1. Copy your plugin folder to `~/.redlog/plugins/<id>/`.
2. Open **Settings ▸ Plugins** and click **Reload** (or restart RedLog).
3. 🟢 plugins are active immediately; toggle them with **Enable/Disable**.
4. 🔴 plugins show **NEEDS CONSENT** — **Review & trust** to run them.

The panel shows each plugin's tier, status, what it contributes, and (for 🔴)
the capabilities it requests.

To try the examples:

```bash
cp -r examples/plugins/recon-pack ~/.redlog/plugins/
cp -r examples/plugins/geoip-tool ~/.redlog/plugins/
```

---

## What can be a plugin

RedLog's extension points, and their tier:

| Extension point | Tier | Status |
|-----------------|------|--------|
| Capture integrations (hooks) | 🟢 | ✅ shipped (`capture`) |
| Loot / secret detectors | 🟢 | ✅ shipped (`lootPatterns`) |
| Redaction rule-packs | 🟢 | ✅ shipped (`redaction`) |
| Target extractors | 🟢 | ✅ shipped (`targetExtractors`) |
| Event types + timeline lanes | 🟢 | ✅ shipped (`eventTypes`) |
| MCP tools (agent-operable) | 🔴 | ✅ shipped (`mcpTools`) |
| Exporters / reporters | 🔴 | 🛣️ reserved (`exporters`) |
| Background monitors | 🔴 | 🛣️ reserved (`monitors`) |

**Design principle:** anything that can be expressed as **data** (patterns,
rules, metadata) or as an **out-of-process script** stays 🟢 and needs no trust,
because it can't touch the evidence chain. Anything that must **run code inside
RedLog** is 🔴, isolated, capability-scoped, and human-approved — because in an
audit tool, executing untrusted code against the record is the exact risk the
tool exists to prevent.
