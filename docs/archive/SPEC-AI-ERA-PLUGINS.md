# Spec — AI-Era Capture Gaps as Plugins (blueprint)

Written 2026-08-13. Companion to `CAPTURE-SOURCE-TAXONOMY.md`, which concluded:
the 15 substrate capture items ship built-in; everything tool-specific is the
long tail → plugin. This blueprint takes the four AI-era gaps that survey named
and maps each onto RedLog's existing plugin contribution surface
(`src/core/plugins/types.ts`), stating for each: **which contribution type,
which trust tier, whether it is expressible today or needs an API extension,
the local-execution cost, and the install/config path.**

## Contribution surface (what exists to build on)

🟢 declarative (trust-free, data or out-of-process, can't touch the chain):
`lootPatterns`, `redaction`, `commandTags`, `targetExtractors`, `eventTypes`,
`capture` (hook that POSTs to the local API), `tailers` (long-running file/stream
follow; **user-plugin tailers are trust-gated**, bundled are free — `types.ts`
L144).

🔴 privileged (isolated utilityProcess, capability-scoped `ctx`, hash-pinned
consent): `mcpTools`; **`monitors` and `exporters` are declared but reserved —
not yet implemented.**

## Gap 1 — Structured scan output (nmap XML, nuclei JSON, httpx, …)

- **Today the shell substrate captures the *command* and raw stdout; the
  structured artifact (XML/JSON) is not parsed into typed findings.**
- **Contribution:** `capture` (parse-on-complete) **+** `eventTypes` (timeline
  identity for `scan_result`) **+** `targetExtractors` (hosts/ports → targets)
  **+** optional `lootPatterns` (secrets in banners). All 🟢.
- **Interface:** a `capture` script wraps or post-processes the tool
  (`nmap -oX -`, `nuclei -json`), reads the structured output, and POSTs one
  event per host/finding with `agent_type: 'scanner'`, `subtype: 'scan_result'`,
  and the parsed fields (port, service, template-id, severity). Severity/loot are
  **inferred suggestions** (§3), never authoritative.
- **Expressible today:** ✅ no API change.
- **Local cost:** parse runs once at scan completion — cheap; output files can be
  large but only the parsed events enter the chain (raw file optionally io-sidecar'd).
- **Install:** `installMethod: manual` (wrap the tool invocation) or a `tailers`
  follow of the scan-output directory. Ships as a bundled `scan-parsers` pack.

## Gap 2 — C2 framework logs (Sliver, Cobalt Strike, Mythic)

- **C2 beacons are an out-of-band channel RedLog isn't sitting on** — the
  substrate items don't see them. Beacon check-ins, task results, and operator
  commands live in the C2 server's own log/DB.
- **Contribution:** `tailers` — follow the C2 framework's log file (Sliver's
  JSON log, CS Aggressor/beacon logs), emit `agent_type: 'scanner'` /
  `subtype: 'c2_checkin'` / `pivot` events per line. 🟢, but **bundled-only
  today** — user-plugin tailers need the isolation work slated for v0.8.3+
  (`types.ts` L144); a bundled `c2-tailers` pack ships now, user-authored C2
  tailers wait on that.
- **Interface:** the `TailerLike` adapter (`tailer-registry.ts`) — the plugin
  supplies a module that tails a path and yields parsed events; the host wires it
  to `tailer-host`. Config the log path per C2 tool.
- **Expressible today:** ✅ via `tailers`; the only friction is the user-plugin
  trust gate (by design).
- **Local cost:** file-follow (inotify/poll) — low, continuous; the exposure
  window is the standing tail, matching the §2 "ambient = opt-in" rule.
- **Install:** point the tailer at the C2 log path; `manualSteps` document where
  each framework writes its log. Ships as a bundled `c2-tailers` pack.

## Gap 3 — Third-party MCP tool-calls (HexStrike, PentestMCP, …)

- **Nuance:** when the operator's AI client has a native hook (Claude Code's
  `PostToolUse`), MCP tool-calls are **already captured** as `agent` events —
  *no gap*. The gap is only clients **without** a hook.
- **Contribution:** a **MCP tee/proxy** the client points at, which forwards to
  the real MCP server *and* POSTs each `tool_call`/`tool_result` to RedLog — a 🟢
  `capture` (out-of-process, unprivileged). Emits `agent_type: 'agent'` /
  `subtype: 'tool_call'` with the tool name, input, and output digest.
- **Interface gap:** no new contribution *type*, but there is **no documented
  MCP-proxy pattern or helper today** — this needs a first-class example
  (`examples/plugins/mcp-tee`) and a thin stdio/HTTP-MCP shim the operator drops
  between client and server. The shim is the deliverable, not a new API.
- **Distinguish from `mcpTools` (🔴):** `mcpTools` = RedLog *exposes tools to*
  an agent (RedLog is the server). This gap is the inverse — capturing calls the
  agent makes to *someone else's* MCP server (RedLog is a passive tee). Keep them
  named apart in docs or they conflate.
- **Expressible today:** ⚠️ mostly — needs the proxy shim + example, no core change.
- **Local cost:** one extra hop per tool-call through the tee — negligible for
  interactive use; the tee is out-of-process so it can't stall RedLog.
- **Install:** `manual` — reconfigure the AI client's MCP server URL/command to
  point at the tee. `manualSteps` per client.

## Gap 4 — Injection / tool-call-hijack semantic labels

- **When the operator tests an AI *target*** (OWASP LLM/Agentic Top 10, MITRE
  ATLAS), the exchange is already captured as `http` (API calls) + `agent`
  (attacker transcript). What's missing is the **labelling** — "this request was
  a prompt-injection attempt," "this response shows tool-call hijack."
- **Two-part answer, by detectability:**
  - **Regex/heuristic subset** (known payload markers, canary strings): 🟢 a
    pattern contribution in the `lootPatterns` mould, but emitting a
    **`detection` suggestion** (inferred, confidence-scored, operator-promotable
    per §3), not a loot/secret. Today `lootPatterns` only classifies secrets —
    this needs a sibling `detectionPatterns` contribution or a `kind` field on
    the existing one.
  - **Semantic detection** (paraphrased injection, multi-turn goal manipulation):
    a 🔴 **`monitor`** — watches the `http`/`agent` event stream and emits
    inferred `detection` events. **`monitors` is reserved but not implemented**
    (`types.ts` L141) — this gap is its first real use case.
- **Interface gap:** ⛔ needs (a) `monitors` implemented as a 🔴 contribution
  (isolated, capability-scoped read of the event stream + append of inferred
  detections), and (b) an inferred-`detection` event shape that is visually
  distinct and operator-promotable (§3 — dashed vs solid, one-click promote).
- **Local cost:** regex subset is per-event and cheap; a semantic monitor may
  call an LLM (cost/latency the operator opts into) — runs in the isolated
  utilityProcess so it can't block capture.
- **Install:** 🟢 pattern pack loads automatically; 🔴 monitor requires the trust
  gate (it runs code and reads the evidence stream — exactly what the gate is for).

## Summary — build order

| Gap | Contribution | Tier | Ready today? | Blocker |
|---|---|---|---|---|
| 1 Structured scan | `capture`+`eventTypes`+`targetExtractors` | 🟢 | ✅ | none — ship `scan-parsers` pack |
| 2 C2 logs | `tailers` | 🟢 (gated) | ✅ | none — ship `c2-tailers` pack |
| 3 3rd-party MCP | `capture` (MCP tee) | 🟢 | ⚠️ | needs proxy shim + `examples/plugins/mcp-tee` |
| 4 Injection labels | `detectionPatterns` (🟢) + `monitors` (🔴) | both | ⛔ | implement `monitors`; add inferred-`detection` event shape |

**Sequence:** Gaps 1 & 2 first (pure packs, zero core change, immediate value).
Gap 3 next (a shim + example). Gap 4 last — it is the only one that grows the
core plugin API (`monitors` + the inferred-detection event type), and it should
land alongside the §3 promotion UI so a detection suggestion has somewhere to go.

## Non-goals

- No gap turns into a built-in capture source — the substrate already captures
  the medium (shell/HTTP/agent); these are *parsers, tailers, tees, and
  labellers* over captured evidence, correctly plugin-scoped.
- `monitors` must not become a back door to unlabelled authoritative assertions —
  everything a monitor emits is an inferred suggestion (§3), never fact.

## Cross-references

- Capture taxonomy + build/plugin line: `CAPTURE-SOURCE-TAXONOMY.md`
- Trust tiers + contribution mechanics: `docs/plugin-development.md`,
  `redlog-plugin-system` memory
- Two-tier facts vs suggestions: `DESIGN-PRINCIPLES.md` §3
