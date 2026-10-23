# Implementation Plan: Recording workflow consolidation

**Date**: 2026-10-21, updated 2026-10-22 | **Spec**: [spec.md](spec.md) | **Checkout**: main

## Delivery slices

This plan implements US6 / FR-012–014 and related FR-016 first. US1–4 and US7 have an existing-code audit and bounded Mac acceptance in audit.md and mac-acceptance-20261021.md; that evidence is not a complete cross-platform verdict. US5 optional AI installation is the subsequent implemented slice, with Mac native acceptance recorded in ai-mac-acceptance-20261022.md. The overall specification stays Draft.

## Summary and technical context

Replace ExportMenu's format menu followed by a preview with one existing-style dialog: range, format, policies, destination, resolved preview, attachments and one confirmation. React 19 / TypeScript / Electron 44, existing local ExportPlan IPC and SQLite persistence. No dependencies, schema, capture producer or backend policy changes. Vitest + Testing Library verify requests and races; affected Electron journeys verify exported bytes. macOS native UI acceptance supplements them. Desktop small windows and zoom are in scope; no mobile app is introduced.

## Canonical interface and invariants

Use src/core/export-plan.ts and export-capabilities.ts unchanged, via resolveExportPlan / executeExportPlan. Copy the view contribution and shared filter when opening. Range is current-selection or all; format does not alter it. Changing range, format, policy or attachments invalidates the old plan immediately and resolves a new one; out-of-order replies cannot enable confirmation. Execute sends only the approved plan id and destination. Closing invalidates pending replies. A failed single-use plan requires re-resolution.

Format choices preserve JSON, NDJSON, bundle, and a contributing view's HAR/timeline. Default to that view's specialized format if present; otherwise retain the existing remembered general format. PII and masking controls are disabled with explanations when unsupported; disable PII-incompatible format options while PII is selected, without silently clearing the policy. HAR must not claim scope masking. Destination is independent from selection. Attachment exclusions survive format switches within the dialog.

## Constitution check (before and after design)

Evidence integrity and canonical semantics: no source mutation or duplicated selection rules. Surface truthfulness: actual plan counts, scope and errors; unsupported policies do not claim success. Query completeness: store resolves the whole bounded query, never renderer rows. Preview/execute: one resolved plan, latest request only. Verification: failing behavior tests precede implementation, then regression, typecheck, i18n, architecture, specs, build and affected Electron journeys. Restraint: no new export service or framework. No violations identified.

## Source and documentation

- src/renderer/src/components/ExportMenu.tsx: dialog and local request transitions.
- src/renderer/src/i18n/{en,zh-TW}.json: range/format purpose labels.
- test/export-*.test.tsx: behavior and retained policy/attachment regressions.
- e2e/{export-preview,filtered-export}.spec.ts: keyboard, narrow viewport and artifact verification.
- specs/062-recording-workflow-consolidation/{research,data-model,quickstart,tasks,verification}.md and contracts/export-dialog.md.

No new architecture or domain invariant is required. Existing docs/domain/SPEC-export-event-selection.md remains authoritative.

## US5 first increment — local installation only (2026-10-22)

The next bounded increment is the official AI capture-plugin installation backend, through the existing plugin IPC/preload surface. The three offline manifest templates live in code, outside auto-discovery, and are written to the user plugin directory only on an explicit request. No download, package manager, AI-tool installation, transcript read, or project-config mutation occurs. Core manager owns an allowlist and validates managed bytes before replacing/removing anything. Modified directories, symlinks and unknown ids fail explicitly. Catalog read errors remain errors. Installation state is not recording state.

This increment does not satisfy all US5: per-tool project activation, project-scoped watch paths, start boundary, health/UI and removal of the old AI preset still require T015–T019. The installed templates declare no executable code or capture contribution until that integration is implemented. Do not advertise the backend as a working AI capture plugin UI. No new framework or persisted evidence schema.


## US5 integrated implementation (2026-10-22)

T015–T018 replace the former AI preset with `agent-capture-policy.ts`. The existing declarative plugin loader, local installation IPC, project YAML, tailer host and settings components are reused. A fresh installation receipt is bound to explicit per-tool project paths and an activation timestamp. Runtime and health consume the same decision. Empty paths never mean the whole machine. Local exclusions only restrict access; session registration does not grant directories. No privileged third-party execution, new dependency, schema or marketplace is introduced.

Host initialization and all auxiliary callbacks require the current enabled generation. Stop closes/snapshots the former project before merging identity. JSONL start-offset checkpoints preserve the observed connection boundary independently of copied evidence bytes; per-message sources ignore pre-activation files and initial auxiliary-part discovery. From-now behavior is disclosed in settings. Source-reported tool execution remains distinct from independently observed shell output.

Constitution review: privacy/isolation and evidence provenance are explicit; install/query failure stays visible; current projection uses shared policy; changes to capture policy began with failing behavior tests. Real-file E2E caught and repaired discovery excluding hidden source roots/intermediate directories. A complete unit regression also exposed the delayed focus-trap issue; two failing modal tests pin the fix. No constitution exception was required. T019 Mac native manual UI passed after unlock; cross-platform installer/update gates remain open in T008/T012. See ai-mac-acceptance-20261022.md.


## Native friction follow-up — T051–T054 (2026-10-23)

Keep the existing Electron/React surfaces. ManagedHttpProxy owns a volatile HTTPS
nonce-report snapshot for its current process generation and CA fingerprint.
The existing authenticated verification sink records it without creating an
evidence event; stop, failed start, restart or a changed/missing CA invalidates it.
Health continues to distinguish capture readiness from verification and names the
verified client, rather than claiming every tool trusts the CA. Project close
already stops the owned proxy, so no proof is carried to the next project.

FirstRun keeps external-shell setup primary and one built-in fallback. The HTTP
step presents own/capture-browser selection before its existing instructions;
regular browser settings can reopen the same verifier. Core health labels link
to their existing settings pages. No CA trust or proxy-system setting changes
automatically, and no new capture mode is introduced.

Settings search retains the generated text inventory but excludes unresolved
templates and inapplicable WSL states. The CA hit uses a stable key target;
static labels retain the existing text-location fallback. A MutationObserver
waits for asynchronous status content and disconnects on resolution/navigation.
Short Latin terms match tokens, avoiding CA matching cargo/calendar/localhost.

Capture manifests may declare platforms (darwin/linux/win32; absent means all).
The contribution registry and hook detection preserve that metadata, and the
three bundled manual producer packs declare it explicitly. Settings groups
foreign sources without execution steps; a live producer stays visible even
when its platform metadata disagrees. This changes presentation, not ingest or
permission policy. Existing focused runtime, privacy, copy and settings tests
remain the regression boundary; native isolated Mac checks supplement them.


### T049 export-copy closeout (2026-10-23)

Use existing resolved attachment counts and list kinds. Label the count as all
attachments; keep scope/source-chain facts for every applicable projection,
while the existing cast-list warning covers included recordings only. Render
boolean selection values as localized enabled/disabled and omit unset fields
without mutating requests. Keep preview labels from shrinking beside long
selection summaries. Resolver, snapshot, exclusions and execution stay unchanged.

### Native artifact follow-up — T056–T057 (2026-10-23)

Actual bundle inspection found unconditional operator-PII replacement in casts
despite bundle's canonical piiScrubbing:false capability. Remove that implicit
rewrite and obsolete scrubCast helper; copy only the approved prefix bytes,
using bounded chunks for a growing recording. This keeps command io offsets and
published capability semantics intact. Bundle still offers whole-file exclusion,
not automatic recording sanitization; it can retain operator identifiers.
No new format, policy flag, service or schema. The IPC regression uses real
exported bytes, Unicode across chunk boundaries and post-preview appends.

Selection summaries omit empty/unset control values while preserving false/0
and active predicates. The request and frozen selection remain unchanged.
Native source-build Mac artifacts supplement existing selection tests; installers,
cross-platform HUD/update gates and the full scenario matrix remain separate.

### Shell status and prompt follow-up — T058 (2026-10-23)

The reported prompt alternation reproduces without RedLog when Powerlevel10k
and a separate precmd PROMPT renderer are both registered. The caller authorized
removing that competing registration locally; the product installer must not
rewrite other users' themes. No prompt variable, hook order or renderer change
is added to RedLog itself.

Keep the existing enrollment JSON/state machine and command names. The Python
human projection distinguishes `recording enabled` from missing identity and
does not claim acknowledged delivery. Bash/Zsh start shows the resulting state;
only an enabled result can emit a resume. Startup merely announces loading.
The unreachable warning preserves offline spool semantics for identified work,
but explicitly declines a preservation promise when no project identity exists.
Focused shell/PTY regression and local installed-file checks cover the change;
no new framework, flag, alias or capture policy is introduced.

### Measured performance follow-up — T059 (2026-10-23)

Measure the hot paths before changing them. Ordinary Zsh commands invoke the
Python relay repeatedly, so defer HTTP/TLS, subprocess, pathlib and diagnostic
imports until the operations that use them. Preserve output limits, drain
timing, exit codes and enrollment/spool behavior. A shorter select wait did not
improve the measured result and was removed.

HTTP flow selection ranks only metadata, then retrieves complete evidence for
the selected IDs as before. Keep earliest-request/latest-response selection,
duplicates, snapshot boundaries and bodies intact. Add a public contract case
and an opt-in real-SQLite body-heavy benchmark. No schema, index, cache or
dependency is added. The existing 100k-event query budget and settings field
lookup measurements did not justify broader changes. Timing methodology and
limits are recorded in performance-20261023.md; this is not native rendering,
installer or cross-platform performance acceptance.

### Partial setup and internal candidate follow-up — T060 (2026-10-24)

The operator's screenshot shows that "no overflow" is insufficient: a verified
short terminal card beside a long pending HTTPS form pushed work actions below
both, inside a large enclosing card that also contained recent evidence. Move
the existing action group to the header, group recent evidence below terminal
capture and remove the redundant outer card/heading. When Start work is
available it replaces the identical leave destination's Later control. Preserve
both verification states, the pending-source warning, evidence rows and cap,
explicit fallback, scope and HTTP policy. Do not add modes, installation steps
or capture controls. Pin relative geometry in the existing first-run journey.

Installed capture smoke must expect the same terminal-settings route as the
daily Dashboard; its stale captureControl assertion is not a product failure.
Update current setup/capture docs to match Bash auto-output and the actual
external-terminal-first UI. Candidate hashes, installed versus source checks,
CI revisions and remaining manual/platform limits belong in the dated internal
acceptance record, not a blanket Verified status.

### Export preservation follow-up — T061 (2026-10-24)

Use only disposable projects: temporarily make exports/ unwritable or move one
approved attachment aside, then restore in finally. Keep the dialog and request
after failure, resolve a new plan for retry, and verify delivered counts/digests
plus retained source IDs. This is actual EACCES/missing-file behavior, not a
physical disk-full or Windows ACL claim. The new normal-click scenario exposed
persistent toasts above the export dialog, intercepting its action button.
Keep non-modal notifications below modal backdrops; preserve their queue,
announcements, dismiss/reveal actions and persistence. No force clicks, reduced
error duration, new controls, capture policy or export selection changes.

### Test consolidation and collision safety — T062 (2026-10-24)

Keep existing behavioral zoom/time-map tests and the presentation journey;
remove their seven duplicate source regex checks and name the remaining three
width wiring guards honestly. Replace the defunct export dropdown-ancestor
check with dialog viewport and pointer hit-target measurements. Native small
and wide windows supplement layout geometry; neither static strings nor CDP
clicks alone prove usability.

The installed EACCES case exposed same-second overwrite, not an unreliable
permission expectation. Reuse one local exclusive-write function in the current
export IPC module for JSON, NDJSON, HAR and slices. Retain the readable timestamp
and add numeric suffixes on collision, preserving previous artifacts/manifests.
Do not change ExportPlan selection, destination approval or source evidence.
Four fixed-time IPC regressions fail before the fix. Re-run real installed
recovery before accepting a replacement candidate.
