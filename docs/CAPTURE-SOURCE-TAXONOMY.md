# Capture Source Taxonomy — built-in vs plugin, AI-era

Written 2026-08-13. Companion to `SPEC-SCOPE-AWARE-LIFECYCLE.md`. Answers three
questions before the lifecycle work: (1) **what capture items must ship built-in**,
(2) **what the AI era adds to the pentest/red-team tool surface** and whether
RedLog covers it, (3) **where the built-in/plugin line sits** and why the plugin
interface is general enough for the long tail. Everything here is constrained by
one fact: **RedLog runs on the operator's own laptop**, so every capture item is
judged on CPU, disk, IO, and install/config friction, not just coverage.

## The organizing lens (DESIGN-PRINCIPLES §2)

Capture items split by **who initiates the bytes**, which decides default-on vs
opt-in and the exposure profile:

- **Operator-deliberate** (default-on): commands, tool-calls, navigation, targets
  — the operator's own actions. Bounded exposure (fires per-action).
- **Ambient vacuum** (opt-in): clipboard, periodic screenshots — run continuously,
  carry a standing exposure window, so the operator consciously accepts the bet.

The key design move for the AI era: capture the **substrate** (command / packet /
tool-call / screen), not the specific tool. A substrate-level item covers a whole
class of tools; only a tool with its own out-of-band channel needs a dedicated
plugin (see Part 4).

## Part 1 — Built-in capture inventory (17 `agent_type`s)

| # | agent_type | What it captures | Heavy artifact | Local cost | Install / config |
|---|---|---|---|---|---|
| 1 | `shell`/`terminal` | commands (hook or built-in PTY) + output | **`.cast` recording** | disk hog; PTY cheap | shell-source into `.zshrc`, or built-in terminal |
| 2 | `http` | mitmproxy request/response | **io body (sidecar)** | TLS intercept per-flow; dedup+2MB cap | mitmproxy addon + **CA cert trust** (per-OS) |
| 3 | `http_navigation` | page loads in CDP browser | io body | CDP session | launch proxied browser |
| 4 | `browser` | proxied browser capture/nav | io body | as above | as above |
| 5 | `scanner` | mitmproxy / port / vuln scan output (open type) | io body | varies by tool | via API / addon |
| 6 | `dns` | DNS queries | — | light | resolver hook / passive |
| 7 | `agent` | **AI agent tool-calls** (Claude Code `PostToolUse`, etc.) | transcript | tailer light | `claude-settings` hook (Tier A) |
| 8 | `process` | process spawn/exit (ps polling) | — | **polling CPU** | macOS/Linux ps monitor, opt-in |
| 9 | `file_transfer` | ingress/exfil, auto-detected from shell | — | free (rides shell) | none (auto) |
| 10 | `pivot` | tunnels/SOCKS, auto-detected from shell | — | free | none (auto) |
| 11 | `cleanup` | anti-forensics, auto-detected from shell | — | free | none (auto) |
| 12 | `loot` | detected secrets (derived) | — | regex per-event | none (built-in detector) |
| 13 | `marker` | operator finding notes | — | free | operator UI |
| 14 | `screenshot` | desktop capture (periodic + on-demand) | **`.jpg` files** | **capture+encode CPU, disk hog** | opt-in periodic; on-demand free |
| 15 | `clipboard` | clipboard changes (sampled) | — | **poll interval CPU** | **default OFF** (highly sensitive) |
| 16 | `system` | scope_violation / sanitized / *_pruned / pause | — | free (meta) | n/a |
| 17 | *(watchPaths)* `file_transfer` via fs watch | filesystem drops in watched dirs | — | fs-watch cost | needs `watchPaths` list |

**Substrate coverage:** items 1–8 + 14–15 are tool-agnostic — they record the
*medium* (shell, HTTP, DNS, tool-call, screen, clipboard, process) regardless of
which specific tool produced it. Items 9–12 are auto-detections layered on the
shell substrate.

## Part 2 — AI-era tool surface → capture mapping

The 2026 tool stack (per web research) mapped to what it *emits* and which
built-in item captures it. "Gap → plugin" marks the long tail.

| Phase | Common tools (2026) | Emits | Built-in covers | Gap → plugin |
|---|---|---|---|---|
| Recon | Nmap, Shodan, theHarvester, subfinder/httpx/katana, Maltego | shell cmd + output; DNS/HTTP | `shell`+`dns`+`http`, target extract | structured **nmap XML / nuclei JSON** parsing |
| Vuln scan | Nessus, OpenVAS, Nikto, nuclei | shell/scanner output | `shell`/`scanner` | structured findings ingest |
| Web/exploit | Burp Suite Pro, SQLMap, Metasploit | HTTP; interactive consoles | `http` (via proxy), `shell` for SQLMap | **Burp proxy overlap, msfconsole RPC** |
| C2 | Cobalt Strike, Sliver, Mythic | beacon check-ins, own logs | — (out-of-band channel) | **C2 log ingest** (Sliver log / CS Aggressor) |
| Post-ex | BloodHound, Mimikatz, LinPEAS/WinPEAS, Empire | shell cmd; graph data | `shell`+`loot` | **BloodHound graph ingest** |
| **AI-agent** | **PentestGPT, Nebula, hackingBuddyGPT, CAI** | tool-calls; some shell-out | `agent` (native hook) / `shell` (fallback) | tool-specific **native hooks** for richer attribution |
| **AI-MCP** | **HexStrike, PentestMCP** (MCP servers) | MCP tool-calls | `agent` tool-call capture | **🔴 `mcpTools`** for RedLog-as-tool |
| **AI-target** | **DeepTeam, LLM/Agentic red teaming** (OWASP LLM/Agentic Top 10, MITRE ATLAS) | HTTP API calls to target LLM; injection payloads | `http` + `agent` | **semantic labels** (prompt-injection / tool-call-hijack) as `eventType`/loot-pattern |

### The AI-era shift (the load-bearing finding)

The capture surface moved from **"commands + packets"** to also include **agent
tool-calls, MCP server interactions, and LLM API exchanges**. RedLog is
architecturally ready — it already has `agent` capture, the agent-hook framework
(Tier A native / Tier C shell fallback, `docs/plugin-development.md`), and 🔴
`mcpTools`. What the *common built-in* set must explicitly own:

1. **AI-agent tool-call capture** — have it (`agent` + `PostToolUse` hook).
2. **MCP tool-call visibility** — the operator's AI running MCP security tools
   (HexStrike, PentestMCP) is now a primary evidence stream; its tool-calls should
   land like any other action. Partly via `mcpTools`, but capturing *another*
   MCP server's calls is plugin territory.
3. **LLM-target exchanges** — testing an AI *target* is captured as `http`
   (API calls) + `agent` (attacker-LLM transcript); the injection-attempt
   *labelling* is a `eventType`/loot-pattern contribution, not a new source.

Everything tool-specific (Burp, msfconsole, Sliver/CS, BloodHound, per-tool AI
hooks, structured scan parsers) is correctly **long tail → plugin**.

## Part 3 — Local-execution constraints (perf / space / install)

Grouped by the real bottleneck on a laptop:

- **Disk hogs (space):** `.cast` (terminal), `.jpg` (periodic screenshots), io
  bodies. → governed by `SPEC-SCOPE-AWARE-LIFECYCLE.md` (compress→tier→prune,
  size+age triggers). Screenshots/`.cast` are Tier-3 (size/time only), the io
  bodies are Tier-1 (scope-prioritized). Dedup + 2 MB ceiling already cap bodies.
- **CPU (perf):** process ps-polling, clipboard polling, mitmproxy TLS intercept,
  screenshot encode. → interval-tunable + opt-in per §2; the two continuous
  vacuums (clipboard, periodic screenshot) are opt-in precisely for this.
- **Install friction (setup):** the hard ones are **mitmproxy CA cert trust**
  (per-OS, per-browser), **shell hook into `.zshrc`**, **`claude-settings` hook**,
  **CDP browser launch**. Everything else is passive/auto. → `installMethod`
  (`shell-source` / `claude-settings` / `manual`) + `verify` command must make
  each self-describing (see Part 4).

## Part 4 — The built-in / plugin boundary + interface generality

**Ships built-in (common, substrate-level, tool-agnostic):** items 1–15 above +
auto-detections. Rule: *if it captures a medium (shell/HTTP/DNS/tool-call/screen/
clipboard/process) rather than parsing one tool's proprietary output, it's
built-in.*

**Plugin (long tail, tool-specific or personal):** parsing a specific tool's
output/console/DB, or a bespoke in-house tool. Grounded in the existing
🟢/🔴 trust model (`redlog-plugin-system`):

| Need | Contribution | Tier | Runs code? |
|---|---|---|---|
| Recognize a new tool's targets | `targetExtractors` | 🟢 | no |
| Stamp fields on its shell events | `commandTags` | 🟢 | no |
| Give its events a timeline identity | `eventTypes` | 🟢 | no |
| Teach loot detector its secret format | `lootPatterns` | 🟢 | no |
| Add allow/deny redaction | `redaction` | 🟢 | no |
| Capture an out-of-band channel (C2 log, Burp, BloodHound) | `capture` script → local API | 🟢 | no (out-of-process, unprivileged) |
| Let an AI agent operate RedLog | `mcpTools` | 🔴 | yes (isolated utilityProcess, capability-scoped `ctx`, hash-pinned consent) |

**Why the interface is general enough for the long tail:** because built-in
capture is *substrate-level*, a new tool usually needs only a 🟢 `targetExtractor`
+ `eventType` — a few lines of **data**, no code, loaded automatically, unable to
touch the evidence chain. A full `capture` script (still 🟢, out-of-process,
POSTs to the authenticated local API) is needed only when the tool has its own
channel RedLog isn't already sitting on (a C2 beacon, Burp's proxy, BloodHound's
graph DB). Only code that runs *inside* RedLog for an AI agent is 🔴 — isolated,
capability-scoped, human-approved. So: **common = built-in substrate; rare/personal
= 🟢 data or out-of-process script; agent-operable = 🔴 isolated.** The trust cost
scales with the actual risk, and the long tail lands almost entirely in trust-free
🟢.

**Plugin install generality:** every `capture` contribution declares its own
`installMethod` (`shell-source` / `claude-settings` / `manual`), `manualSteps`
(with the `{hookFile}` placeholder RedLog resolves to an absolute path), and a
`verify` command — so the long tail is self-describing about setup even without a
one-click path, matching the local-install reality of Part 3.

### The install/enable separation (four gates, not two)

The lifecycle has **four separate, differently-consequential, independently
reversible** states — the design deliberately splits *enablement inside RedLog*
from *installing a hook into the operator's environment*:

| Gate | State | Where it lives | Blast radius | Reversibility |
|---|---|---|---|---|
| 1 | **Present** | folder in `~/.redlog/plugins/<id>/` or bundled | files only | delete folder |
| 2 | **Enabled** | `state.json` `disabled[]`; Settings ▸ Enable/Disable | in-RedLog process; contributions merged | flip a flag, zero external footprint |
| 3 | **Trusted** (🔴 only) | `trust.json` content-hash + capability pin | privileged code may run | revoke consent |
| 4 | **Capture hook installed** | `.zshrc` / `~/.claude/settings.json` via `installMethod`; tracked by `capture-health` `hookInstalled` | **mutates files OUTSIDE RedLog that persist when it's closed** | separate uninstall |

**Why gates 2 and 4 must be separate:** enabling merges data into RedLog's own
process — cheap, reversible, no footprint outside the app. Installing a capture
hook mutates *external* system state (`.zshrc`, `~/.claude/settings.json`) that
outlives RedLog's process, so it needs its own consent and its own uninstall.
Conflating them forces a bad choice: either enabling silently edits your shell
config (unrequested footprint), or disabling can't clean up because it never
tracked what it wrote. The split lets the operator vet and enable a plugin safely
in-process **first**, then take the consequential environment-wiring step
deliberately.

**Gotcha to preserve — Disable ≠ Uninstall.** `setPluginEnabled(false)`
(`plugins/index.ts`) only flips `state.json`; it does **not** remove the hook
line from `.zshrc`. Hook uninstall must be its own UI action, or orphaned hook
lines accumulate in the operator's shell config (and keep firing on every shell,
whether or not RedLog is open). Gate 4 (hook install) *is* the "install friction"
of Part 3 (mitmproxy cert, `.zshrc`, `claude-settings`, CDP browser) — isolating
it as one deliberate, separately-reversible step is what makes the local-install
reality manageable.

## Recommendation

- **Ship built-in:** the 15 substrate items + auto-detections. Add nothing
  tool-specific to core.
- **AI-era, promote to first-class built-in emphasis:** `agent` tool-call capture
  and MCP tool-call visibility — this is where 2026 evidence increasingly lives.
- **Everything else → plugin**, and the 🟢-first interface already makes the long
  tail cheap (data/script, trust-free) with 🔴 reserved for agent-operable code.
- **Local cost is handled by the lifecycle spec**, not by dropping capture: disk
  hogs (`.cast`/screenshots/bodies) rotate; continuous vacuums stay opt-in.

## Sources

- Pentest stack 2026 — [PlexTrac](https://plextrac.com/the-most-popular-penetration-testing-tools-this-year/), [Axis Intelligence](https://axis-intelligence.com/best-penetration-testing-tools-tested-guide/), [HackerDNA](https://hackerdna.com/blog/penetration-testing-tools)
- AI red-team frameworks — [Synack](https://www.synack.com/blog/best-ai-red-teaming-tools/), [Straiker](https://www.straiker.ai/blog/top-6-ai-red-teaming-and-adversarial-testing-tools)
- AI pentest agents — [Ostorlab](https://blog.ostorlab.co/8-open-source-ai-pentest-tools-2026.html), [awesome-ai-pentesting](https://github.com/skyvanguard/awesome-ai-pentesting), [appsecsanta](https://appsecsanta.com/research/ai-pentesting-agents-2026)
- Operator logging / evidence — [Red Team Guide — Operator Log](https://redteam.guide/docs/Templates/oplog/), [Hacking Articles](https://www.hackingarticles.in/guide-to-red-team-operations/)
