# RedLog Plugin Marketplace — Design Spec (draft)

Status: **shipped** since v0.6.68 (core) / v0.6.69 (UI). The threat model in §9 was corrected in v0.11.0 to describe what the code actually does — two of its claims described controls that were never built.

## 1. Goal

Today plugins are installed by dropping a directory into `~/.redlog/plugins/<id>/`. That works for the operator who wrote the plugin, but nothing else — no discoverability, no version updates, no way to distinguish "the RedLog team wrote this" from "a random archive I pulled off the internet." The marketplace is the answer to three concrete problems: (a) an operator can browse and install a curated set of loot patterns, capture integrations, and MCP tools without a shell, (b) declarative-tier plugins can auto-update so pattern lists stay current, and (c) privileged-tier plugins can be signed by a publisher key the operator has explicitly trusted, so a compromised or malicious archive can't silently obtain `write:events` or `net:outbound`. The existing manifest schema, trust store (`~/.redlog/plugins/trust.json`), and content-hash pinning already do the heavy lifting — the marketplace is a distribution and consent layer on top.

## 2. Non-goals (v1)

- No paid plugins, no billing, no license enforcement.
- No user reviews, ratings, or comments — trivially poisoned, and irrelevant for an audit tool.
- No cross-vendor identity or SSO — publishers are keypairs, nothing more.
- No in-app plugin authoring or hot-reload UI (that stays in the dev guide).
- No mobile / web client — desktop Electron only.
- No telemetry on install counts back to the RedLog project.

## 3. Distribution model — recommendation: **A. Git-repo-as-registry**

Use a public GitHub repo (`redlog-plugins/registry`) as the index. It contains a single `index.json` listing plugin id, latest version, publisher key id, tarball URL, sha256, and category. Tarballs live wherever the publisher wants — GitHub Releases, S3, a personal server — as long as the sha256 matches. RedLog fetches `index.json` over HTTPS, verifies the tarball hash, and (for privileged plugins) the publisher signature.

Why not the others: **NPM (B)** drags in a package manager and a namespace we don't control, and NPM's own supply-chain history is exactly what we're trying to avoid. **Self-hosted service (C)** means we run infrastructure, handle abuse reports, and become a single point of failure for a security tool. **Hybrid (D)** is where we end up eventually if the git index grows too large, but v1 doesn't need it.

Git-as-registry gives us: free hosting, PR-based moderation with a full audit trail, easy forks for air-gapped shops, and signed commits from the RedLog maintainers as the root of trust for the index itself.

## 4. Plugin package format

A gzipped tarball (`.tar.gz`), because tar preserves file modes and macOS/Linux operators already have it. Structure:

```
<id>-<version>.tar.gz
└── <id>/
    ├── plugin.json        # manifest, required
    ├── README.md          # rendered in the marketplace UI
    ├── LICENSE            # optional but shown
    └── ... (contributed files)
```

Rules enforced during unpack:

- Reject symlinks, hardlinks, absolute paths, and any entry containing `..`.
- Reject entries outside the single top-level `<id>/` directory.
- Reject files with executable bits set except inside a `bin/` subdir (we don't spawn them anyway; this is belt-and-braces).
- Size cap: 5 MiB uncompressed in v1. Bump later if a real use case appears.

The tarball's sha256 is what the index pins. RedLog re-computes it before extraction and rejects a mismatch.

## 5. Signing & trust flow

Two tiers, two flows.

**🟢 Declarative plugins** (loot patterns, redaction, tags, extractors, event types, capture) — signature optional. Install prompt shows a "Publisher: unverified" badge if unsigned, or "Publisher: `redlog-official` (trusted)" if signed by a key in the trust store. No capability prompt because these can't call anything.

**🔴 Privileged plugins** (`mcpTools`, `exporters`, `monitors`, `tailers`) — signature required. The publisher signs the tarball's sha256 with an Ed25519 key; the public key + a human name lives in `~/.redlog/trusted-publishers.json`:

> **`tailers` (v0.8.2)** — transcript adapters for AI coding agents. A tailer module exports `{ adapter }` where `adapter` implements the `TailerAdapter` interface from `src/main/services/tailer-host.ts`. **v0.8.2 restriction:** only bundled tailer plugins (shipped inside the RedLog resources dir) run; user-installed plugins that declare `tailers` produce an advisory in `~/.redlog/log` and are otherwise skipped. Third-party `tailers` require isolation work landing in v0.8.3+ — the current tailer-host would run plugin code in-process at line-rate against the transcript stream, which needs either a faster IPC path than `utilityProcess` or a per-plugin JS sandbox before we can safely open it up.

```json
{
  "redlog-official": { "pubkey": "ed25519:...", "addedAt": 1706... },
  "acme-redteam":    { "pubkey": "ed25519:...", "addedAt": 1706... }
}
```

First install of a plugin from a new publisher shows a two-step consent dialog:

> **Trust publisher `acme-redteam`?**
> Fingerprint: `ed25519:a1b2…c3d4`. Once trusted, you'll be prompted separately for each plugin's capabilities. You can revoke this publisher in Settings ▸ Plugins ▸ Publishers.
> **[Trust publisher]  [Cancel]**

then

> **Install `acme-exfil-monitor` v1.2.0?**
> This plugin asks for: `read:events`, `net:outbound` (⚠ outbound network).
> Content hash: `sha256:9f8c…`
> **[Install]  [Cancel]**

The existing `trust.json` grant is written on approval, pinning both the content hash and the capability set — the enforcement path in `src/core/plugins/trust.ts` already handles this.

**Update behaviour** — after a version bump:

- Hash changed, capability set unchanged → silent upgrade, toast "acme-exfil-monitor updated 1.2.0 → 1.3.0".
- Hash changed, capability set expanded → status flips to `needs-consent`, plugin stops loading its code, operator is re-prompted with the delta highlighted.
- Signature invalid or publisher no longer trusted → status flips to `error`, no code runs.

## 6. Update flow

- Poll `index.json` on app launch (skipped if last poll < 6 h ago) and on every visit to Settings ▸ Plugins.
- Declarative plugins: auto-update by default, togglable per-plugin.
- Privileged plugins: never auto-update the *code* silently. New version → notification badge on the Plugins tab; operator must open it and click "Install update". Applies whether or not capabilities changed — the extra click is cheap and the operator is the audit trail.
- Rollback: keep the previous version's directory at `~/.redlog/plugins/<id>/versions/<contentHash>/`, retain the last three versions, and expose a "Rollback" button in the plugin detail panel. The trust grant for a rolled-back hash is re-usable without re-consent because the hash was previously approved.

## 7. In-app UX

Three new views under Settings ▸ Plugins:

- **Marketplace tab** — search bar, category chips (Loot patterns, Capture, MCP tools, Redaction, Event types), plugin cards showing name, publisher badge, one-line description, `[Install]` button. Filters: "Signed only", "Publisher trusted", "Tier: privileged".
- **Publisher page** — reached by clicking a publisher badge. Lists all plugins from that publisher, trust status (trusted / unverified / revoked), and a Revoke Publisher button.
- **Plugin detail** — rendered README, requested capabilities with tooltips, install size, current content hash, version history with per-version content hash and "Rollback to this version" affordance, "Report abuse" link that opens a `mailto:` or the registry repo's issue tracker.

The existing Plugins tab (installed list, enable/disable, per-plugin capability view) stays as it is; the marketplace is a sibling tab.

## 8. Revocation

The registry serves a `revocations.json` blob alongside `index.json`, signed by the RedLog project key (baked into the app binary at build time — same key that signs the release itself). Each entry: `{ pluginId, version, contentHash, reason, revokedAt }`.

On every poll RedLog fetches the blob, verifies the signature, and:

- If an installed plugin's contentHash is on the list → disable it immediately, set status to `error` with the reason, toast the operator.
- Publisher-level revocation is also possible (whole `pubkey` marked revoked) — every plugin signed by that key flips to `needs-consent` or `error` on next load.

Operator override exists (edit `revocations-override.json` by hand) because an air-gapped shop may need to keep running a plugin the upstream registry has yanked. Not exposed in the UI.

## 9. Security threats

1. **Typosquatting** (`acme-redteem` vs `acme-redteam`) — the marketplace UI shows publisher next to every plugin name and dims plugins whose publisher isn't in the trust store; PR review on the git registry is the primary defence for new registrations.
2. **Publisher key compromise** — the operator untrusts the key in Settings ▸ Plugins ▸ Marketplace ▸ Publishers; every plugin signed by it stops verifying, and an update cannot install. `~/.redlog/plugins/revocations.json` is a **local blocklist the operator maintains** — RedLog never fetches it from the network, because without a root of trust a fetched revocation list is only as honest as whoever served it (and a compromised publisher will not revoke itself). *(Earlier revisions described automatic signed revocations. That mechanism was never built; the file and the UI tab are the manual blocklist they always were.)*
3. **Capability escalation via update** — content-hash pinning + capability comparison in `trust.ts` already forces re-consent on any capability delta. The UX highlights added capabilities in red.
4. **Malicious index** — **the index is untrusted and RedLog does not verify it.** There is no root key to check it against, and TLS only proves the bytes came from whoever holds the domain, which is exactly who an attacker would need to be. The index says *where to look*, never *what is safe*. The trust boundary is one step later: `installFromRegistry` verifies each tarball's Ed25519 signature against a key the **operator** pinned, and refuses a privileged plugin that has none. A hostile index can therefore waste your time and serve you a tarball, but cannot get code executed — unless you pin its key, which is why trusting a publisher is a per-publisher action showing the fingerprint you are expected to compare against that publisher's own channel. *(Earlier revisions of this document claimed unsigned index mutations were rejected. They never were; the claim was removed in v0.11.0 along with the one-click "trust all suggested publishers" button, which let whoever controlled the index pin their own key.)*
5. **Network downgrade / MITM** — HTTPS-only, no `http://` fallback, and the tarball sha256 is pinned in the index so a modified tarball fails even if TLS is broken.
6. **Malicious tarball contents** — the unpack rules in §4 prevent symlink escapes and path traversal; the plugin runs in the existing utility-process sandbox with capability-gated RPC (see `src/core/plugins/host.ts`), so even a hostile privileged plugin can't reach the DB handle or signing keys.

## 10. Implementation phases

**v1 — minimum shippable**

- Registry repo skeleton + `index.json` schema + `revocations.json` schema.
- In-app Marketplace tab: browse, search, install, uninstall, update.
- Publisher trust store + first-install consent flow.
- Ed25519 signing tooling (a small `redlog-sign` CLI in the repo).
- Rollback to previous content hash.
- Documentation update to `plugin-development.md` on how to publish.

**v2 — nice-to-have**

- Bulk "trust curated set" for new operators (one-click trust of `redlog-official`).
- Publisher key rotation flow (old key signs an attestation for the new key).
- Delta updates (bsdiff-style) for large plugins — probably unnecessary given the 5 MiB cap.
- Air-gap export bundle: `redlog plugins export --all` produces a zip an operator can `redlog plugins import` on a disconnected machine.

**v3 — far future**

- Private/internal registries (point RedLog at a company-internal git repo).
- Plugin dependency resolution (plugin A depends on plugin B's event types).
- In-app publisher onboarding (currently: file a PR).

## 11. Open questions

1. **Root of trust distribution** — the RedLog project key is baked into the binary. What is the rotation story if that key is compromised? Ship a new binary is the honest answer; is that acceptable?
2. **Publisher onboarding friction** — is "open a PR against the registry repo" enough gatekeeping, or do we need out-of-band identity verification for publishers who want to ship privileged plugins?
3. **Capability granularity** — `net:outbound` is a single bit today. Do we need domain-scoped variants (`net:outbound:*.slack.com`) before opening the marketplace, or after evidence that plugins want it?
4. **Registry scale** — at what plugin count does the single `index.json` become a problem? Rough cap before we split into category shards?
5. **Event provenance** — a privileged plugin with `write:events` currently attributes its events to itself. Should the marketplace enforce a stricter provenance label (`plugin:<id>@<version>@<contentHash>`) in the event data so audit reviewers can filter plugin-authored events without operator config?
