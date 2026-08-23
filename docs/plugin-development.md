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

### `commandTags` — stamp fields onto shell events when a pattern matches

```jsonc
"commandTags": [
  { "name": "mitre:nmap",       "match": "^nmap\\b",         "stamp": { "mitre_ttp": "T1046",     "technique_tool": "nmap",   "technique_category": "recon" } },
  { "name": "mitre:mimikatz",   "match": "mimikatz",        "flags": "i",
    "stamp": { "mitre_ttp": "T1003.001", "technique_tool": "mimikatz", "technique_category": "cred_access" } },
  { "name": "mitre:hashcat",    "match": "^(hashcat|john)\\b","stamp": { "mitre_ttp": "T1110.002", "technique_category": "cred_access" } }
]
```

For every `shell.command_start` event, each pattern is tested. First-match-wins
per field — an earlier pattern can shadow a later one for the same key. The
`stamp` object's keys are free-form; reserved names that downstream tooling
(Ghostwriter, VECTR) understands are `mitre_ttp`, `technique_tool`, and
`technique_category`, but you can add your own for org-specific pipelines.

**Why this is a plugin instead of a core feature:** ATT&CK tagging is opinionated,
tool lists go stale, and most mature shops let a SIEM (ELK, Splunk, Chronicle)
do the tagging with richer context. RedLog ships **no** commandTags out of the
box — install one (or write your own, or leave the shell events raw and tag
them downstream).

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

#### Wrapping a new AI agent (the practical guide)

Every dedicated agent hook trades context for coverage. Pick the highest tier
the agent gives you:

| Tier | When | Effort | Context you get |
|---|---|---|---|
| **A. Native hook API** | Agent exposes hook events (Claude Code's `PostToolUse`) | Low | session_id, tool name/input/output, transcript path |
| **B. SHELL wrapper** | Agent lets you override the shell it spawns (Codex `SHELL=…`) | Medium | full command line, exit code, cwd, agent name |
| **C. Fallback: shell hook** | Agent just execs Bash and doesn't tell you it did | None (already covered by `shell-*` built-ins) | command + exit code; no agent attribution |

Only bother writing a plugin for **A** or **B**. If the agent gives you
nothing, the built-in `shell-zsh` / `shell-bash` already catches its output —
just with the caller unknown.

##### Choosing an installMethod

The `installMethod` field decides how RedLog wires the hook into the operator's
environment:

- **`claude-settings`** — writes into `~/.claude/settings.json`'s `hooks` block.
  Only usable when the target agent reads that file. Currently Claude Code is
  the only one; if a new agent adopts the same convention, this will Just Work
  for it too. RedLog picks the matcher name from `claudeSettingsMatcher`.
- **`shell-source`** — copies the hook to `~/.redlog/<name>` and appends a
  `source …` line to `shellRcFile` (default `.zshrc`). Fires on every shell
  command; use it for wrappers whose entry point IS the shell.
- **`manual`** — RedLog just prints the setup steps and lets the operator
  paste them. Use for anything that needs manual `SHELL=…` env exports,
  custom systemd units, or agent-specific config edits.

##### Hook script contract

Whichever tier you're in, the hook eventually POSTs one JSON object per event
to `http://127.0.0.1:${port}/api/events`. Minimum shape:

```jsonc
{
  "agent_type": "agent",           // or "shell" if command-line grade
  "data": {
    "subtype": "opencode_tool",  // free-form; group in the timeline
    "command": "sed -i s/a/b/ foo",
    "output_preview": "…truncated…",
    "session_id": "…",             // if the agent gives you one
    "cwd": "/path/to/engagement",
    "tool": "shell",
    "wrapper": "opencode"             // your plugin id
  }
}
```

Port + token live at `~/.redlog/api-port` and `~/.redlog/api-token`. Curl
timeouts must be short (`--connect-timeout 1 --max-time 2`) so a paused or
gone RedLog doesn't wedge the agent's tool loop.

Read the two hooks you already have — they cover both extremes:

- [`hooks/claude-code-hook.sh`](../hooks/claude-code-hook.sh) — Tier A. Reads
  Claude Code's stdin JSON payload, applies redaction, POSTs. Also implements
  the two-gate privacy filter (recording state + cwd exclusion) that any
  new agent hook is welcome to inherit.
- [`hooks/codex-wrapper.sh`](../hooks/codex-wrapper.sh) — Tier B. Wraps every
  shell command spawned by Codex; fires a command_start before and a
  command_end after with exit code + duration.

##### Full example: OpenCode

OpenCode is a Tier A agent — it exposes a native plugin API (`tool.execute.after`)
that auto-loads any `.mjs` / `.ts` from `.opencode/plugins/` (project-scoped)
or `~/.config/opencode/plugins/` (global). Docs: <https://opencode.ai/docs/plugins/>.

Live reference: [`examples/plugins/opencode-hook/`](../examples/plugins/opencode-hook/).

`plugin.json`:

```json
{
  "id": "opencode-hook",
  "name": "OpenCode",
  "version": "0.1.0",
  "redlogApi": 1,
  "contributes": {
    "capture": [{
      "id": "opencode-plugin",
      "name": "OpenCode (plugin API)",
      "agentType": "agent",
      "requires": ["opencode"],
      "hookFile": "plugin/redlog.mjs",
      "installMethod": "manual",
      "manualSteps": [
        { "label": "Project-scoped install:",
          "command": "mkdir -p .opencode/plugins && ln -sf \"$PWD/examples/plugins/opencode-hook/plugin/redlog.mjs\" .opencode/plugins/redlog.mjs" },
        { "label": "Global install (every OpenCode session):",
          "command": "mkdir -p ~/.config/opencode/plugins && cp examples/plugins/opencode-hook/plugin/redlog.mjs ~/.config/opencode/plugins/redlog.mjs" }
      ]
    }]
  }
}
```

The plugin module exports a `Plugin` factory that returns
`{ 'tool.execute.after': async (input, output) => ... }`. The hook body reads
`~/.redlog/api-token` + `~/.redlog/api-port`, applies the two-gate privacy
filter (recording + cwd exclusion), redacts common secret shapes from the
output preview, and POSTs an `agent` event with
`subtype: opencode_tool`. It's ~130 LOC and never throws — a failed capture
must never break the operator's OpenCode session.

##### Testing your plugin

1. Drop the plugin dir under `~/.redlog/plugins/` or your project's
   `.redlog/plugins/`.
2. Restart RedLog (or click **Reload** in Settings ▸ Plugins).
3. The plugin should appear in Settings ▸ Plugins as 🟢 declarative and in
   Settings ▸ Hooks as an installable capture.
4. Fire the hook for real by running the agent:
   ```bash
   opencode run "list files in /tmp"
   ```
5. Verify the events land via CLI or timeline:
   ```bash
   redlog-cli events --agent_type agent --limit 3
   ```

If nothing shows up: check RedLog is recording, check the cwd isn't in
your exclusion list, and confirm the plugin loaded (`opencode` prints a
warning on startup if a plugin file fails to import).

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
| Command taggers (MITRE / custom stamping) | 🟢 | ✅ shipped v0.6.15 (`commandTags`) |
| Event types + timeline lanes | 🟢 | ✅ shipped (`eventTypes`) |
| MCP tools (agent-operable) | 🔴 | ✅ shipped (`mcpTools`) |
| Exporters / reporters | 🔴 | 🛣️ reserved (`exporters`) |
| Background monitors | 🔴 | 🛣️ reserved (`monitors`) |

**Deliberately NOT extension points:**

| Would-be extension | Why it lives outside RedLog |
|-----|-----|
| Report writers (Ghostwriter / HackerOne / Bugcrowd format) | External tools do this better with fuller context — RedLog's job is the audit log, not the report |
| STIX 2.1 / VECTR / adversary-emulation-plan export | Same — feed a downstream converter from the evidence bundle |
| Downstream ATT&CK correlation | A SIEM (ELK / Splunk / Chronicle) does this with more signal than a pattern list |

**Design principle:** anything that can be expressed as **data** (patterns,
rules, metadata) or as an **out-of-process script** stays 🟢 and needs no trust,
because it can't touch the evidence chain. Anything that must **run code inside
RedLog** is 🔴, isolated, capability-scoped, and human-approved — because in an
audit tool, executing untrusted code against the record is the exact risk the
tool exists to prevent.
