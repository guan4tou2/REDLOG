# Verification: filtered evidence export (projection slice)

Date: 2026-10-13. Source baseline: main 9f8bf28. Local branch:
fix/recording-closeout-opencode. The feature is Implemented; native installer acceptance remains separate and
unverified tasks are not marked complete.

## RED

Real SQLite fixtures exported through exportBundle and checked by the standalone
Python verifier reproduced policy omissions in the middle (prev_hash mismatch),
at the tail (source head mismatch), a noncontiguous selection, and scope-masked
payloads (original hash mismatch). These are exporter/verifier integration cases,
not seeded Python-only rows.

## Implemented contract

Complete-chain deliveries retain strict link/head/hash verification. Projection
deliveries check declared file digests, per-tier counts, distinct identities and
eligible unchanged source rows; transformed source payloads/signatures and the
original source-chain completeness are explicitly not verified. A manifest
checksum is required and verified, including zero-row and projection bundles.
Checksums and exporter-declared selection metadata do not independently
establish source authenticity if both content and metadata are replaced.

Policy exclusion counters for approved plans describe the approved candidate
population, while sourceChain minus delivered chained count reports all omitted
source-chain rows. The two populations must not be conflated. Source DB rows
and their original hashes are never rewritten.

## Verification

Focused regressions cover middle/tail/all policy omissions, noncontiguous
selection, masking, unchanged full-chain behavior, modified payloads, deletion,
duplicate identities, unknown mode, missing files/digests, count mismatch,
manifest metadata changes, and frozen-plan exclusion metadata.

Typecheck, verify:specs, verify:architecture, verify:i18n and build passed.
The final focused test result is recorded in the task handoff artifact.

OpenCode v2.0.28 with opencode/space-bunny-free independently reviewed the
projection change. Its manifest-checksum finding led to an additional guard
and regression. Declared-versus-authenticated metadata limits are now reported;
no claim of full source-chain verification is made for a projection.

## Packaged macOS follow-up

macOS ARM: a candidate DMG was mounted read-only and copied to an isolated
install folder. Real loopback HTTP request/response through managed mitmdump,
HTTP/HTTPS nonce verification, then export through ExportPlan and execution of
the shipped Python verifier pass. The bundle is explicitly a projection;
its exported command/output and `.cast` file are also asserted. This exercises
the policy-omission scenario on macOS, not only synthetic fixtures.

## Still not verified

Local package execution is macOS. Windows clean-host installer acceptance is
tracked in PR #335's dedicated CI, not inferred from macOS or a previous main
run. Kali desktop and native WSL acceptance remain unrun. Do not close #329 or
mark the full Spec Verified while its platform criteria remain incomplete.

## 2026-10-14 selection and attachment completion

New RED tests show malformed array/Map/Date filters and HTTP predicates silently
widened the selection. Validation now rejects them. JSON, NDJSON and Timeline
exports each include all 1,005 matches beyond the first page, exclude all 1,005
interleaved nonmatches, and exclude a backdated match inserted after preview.
HTTP tests include method/status/host/text, late eligible responses, repeated
response updates and response-only flows; HAR entries match the frozen pairs.

An equal-size attachment edit passed the old count-only check (RED). Included
file content is now digested at preview and rechecked at execute. A changed
file invalidates the plan; operator-excluded files do not enter the bundle.

Real English and Traditional Chinese Electron journeys exercise current
selection, literal conditions, zero results, invalid query, compact dialog,
keyboard confirmation, and read the exported JSON. A new matching row inserted
while preview is open is absent from the confirmed file. The test helper now
actually honors REDLOG_PACKAGED_APP rather than silently using source output.

The 18-journey source round includes these flows, setup recovery/dependency
failure, terminal enrollment and project rotation. Final installed-candidate
results and gate counts are recorded in the delivery artifact. Windows/WSL and
Kali desktop acceptance remain T015; no unsupported Verified claim is made.

Final installed macOS candidate: 22 journeys PASS, including both locales'
filtered/frozen JSON export. The packaged bundle smoke verifies the delivered
cast's printed output rather than requiring an inline stdout property which
built-in PowerShell does not provide. The canary command text alone does not
count as recorded output. UI timeout tests wait for the async running state
before advancing the clock; no product timer or certificate check is relaxed.
