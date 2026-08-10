# Cloud Share Bundle — design spec (draft)

Status: **shipped** since v0.6.69. Items still marked *(deferred)* are unbuilt. The threat model in §11 was corrected in v0.11.0 — one of its claims described a server-side check that does not exist.

## 1. Goal

After finishing an engagement, the operator wants to hand the sanitized evidence bundle to a client or an internal manager. Today they click **Export bundle** ([`src/core/bundle-export.ts`](../src/core/bundle-export.ts)), get a directory of `events.jsonl + screenshots/ + casts/ + manifest.json`, zip it, and email or Slack-drop it. That flow breaks in five obvious ways: bundles routinely exceed the 25 MB attachment ceiling most mail providers enforce; corporate mail gateways quarantine `.zip` attachments; the client's phone can't unzip an evidence pack in an airport; the sender has no way to *revoke* the file once it's out; and the sender has no signal that the recipient actually opened it. A short share URL fixes all five: no attachment (no quarantine), no size ceiling other than what our backend allows, mobile-viewable in a browser, one-click revoke, and a single "opened" ping so the operator knows the deliverable landed.

## 2. Non-goals (v1)

- **No viewer analytics beyond "opened at T, from IP prefix P".** Not tracking dwell time, per-file access, geolocation, or heatmaps. Anything richer feels like surveilling the client.
- **No in-browser interactive replay.** `.cast` playback and chain-verify UI live in v2. v1 is *download the zip*.
- **No multi-tenant collaboration.** No comments, no per-viewer permissions, no shared workspace. The share URL is a one-way delivery, not a workspace.
- **No re-encryption at rest by the backend.** The bundle is treated as opaque bytes. Optional client-side encryption is a v2 idea (Open Question 3).
- **No CI/webhook triggers.** Operators click a button in the app. Programmatic uploads via CLI are v2.

## 3. Backend hosting

**Recommendation: option D — a RedLog-hosted default on top of Cloudflare R2 + Workers, with a "bring your own bucket" escape hatch that points at any S3-compatible endpoint (R2, S3, MinIO).**

Comparison:

| Option | Pros | Cons |
|---|---|---|
| A. R2 + Workers | Zero egress cost (bundles are download-once-ish), signed URLs and edge auth trivial, one vendor | R2 durability/availability track record shorter than S3 |
| B. S3 + CloudFront + Lambda | Most mature, operators trust AWS | Egress cost real, IAM/CloudFront/Lambda sprawl for what is a small service |
| C. Self-hosted MinIO only | Data never leaves the operator's org | Every team has to run infra before they can use the button; kills the "click Share, get URL" UX |
| D. RedLog-hosted default (R2+Workers) + BYO-bucket config | Ships as one click for new users; teams that can't legally use us point at their own MinIO/R2/S3 | RedLog project becomes a data custodian for the default tier |

**Legal implication of running the default tier.** Hosting sanitized evidence for other people's engagements makes the RedLog project a data processor for that content. That means: a published DPA, a documented retention policy (see §11), a jurisdiction statement (R2 buckets pinned to EU or US at signup), and a delete-my-data endpoint. Teams that can't legally hand evidence to a third party — most consultancies with client NDAs, and anyone doing gov work — MUST be able to flip a single settings toggle to point uploads at their own bucket, at which point the RedLog project sees zero bundle bytes and stores only the share-URL registration (or nothing, if they self-host the KV too). BYO-bucket is not an afterthought; it's how we make the default tier acceptable to ship at all.

## 4. Bundle format on the wire

**Same `.zip` as local export, plus a top-level `bundle.json` manifest.** No new streaming format. Rationale: the existing bundle already has a `manifest.json` with per-file SHA-256 and a chain-head anchor; wrapping it in a zip is the smallest possible delta and keeps the downloaded artifact byte-identical to what `redlog-cli export bundle` produces locally.

`bundle.json` (new, wraps the existing manifest for the backend's benefit — the operator can read it without unzipping):

```json
{
  "schema": "redlog.share/1",
  "engagementId": "…",
  "engagementSlug": "acme-external-2026q3",
  "createdAt": "2026-08-01T14:22:00Z",
  "bytes": 87342112,
  "sha256": "…",
  "eventCount": 4812,
  "chainHead": { "hash": "…", "eventCount": 4812 },
  "lastAnchor": { "id": "…", "status": "confirmed", "createdAt": 1754060400 },
  "sanitized": { "events": 47, "totalInDb": 47 }
}
```

**Bounded upload size: 100 MB default, override in Settings ▸ 分享 up to a hard cap of 2 GB.** The chain-head hash and sanitized counts travel in `bundle.json` so a reviewer can compare them against what the operator saw in the pre-upload dialog. This is a record, not an enforcement point — the Worker does not read `bundle.json` (see §11 threat 3).

## 5. Upload flow

Client:

1. Operator clicks **Share to cloud** in the engagement toolbar.
2. App runs the existing sanitize pass — same code path as `redlog-cli export bundle`, layer 4 of the redaction design.
3. App renders the **redaction preview** dialog (§9). Upload button is disabled until the operator ticks *I have reviewed*.
4. App zips the bundle to a temp dir, computes SHA-256.
5. App calls `POST /api/share/init` with the manifest summary.
6. App `PUT`s the zip bytes to the returned signed URL.
7. App calls `POST /api/share/complete` with the object key and observed SHA-256.
8. App gets back `{ shareUrl, expiresAt }`, shows it, offers *Copy link / Open / Revoke*.

API sketch:

```
POST /api/share/init
  auth: Bearer <device-token>
  body: { engagementSlug, bytes, sha256, eventCount, chainHead, expiryDays }
  200:  { putUrl, objectKey, shareId, headers: {…} }   // signed PUT, ~15 min TTL

PUT  {putUrl}
  body: <zip bytes>
  headers include an x-amz-checksum-sha256 the backend re-verifies

POST /api/share/complete
  body: { shareId, sha256 }
  200:  { shareUrl, expiresAt }

GET  /e/{engagementSlug}-{suffix}         // download page (HTML)
GET  /e/{engagementSlug}-{suffix}.zip     // signed download of the object
POST /api/share/{shareId}/revoke          // uploader only
GET  /api/share/mine                      // list operator's active shares
```

## 6. Share URL structure

`https://share.redlog.dev/e/{engagement-slug}-{suffix}`

- `engagement-slug` — human-readable, e.g. `acme-external-2026q3`. Comes from the engagement record; operator can override at share time. Not treated as a secret.
- `suffix` — 8 characters of base32-Crockford, drawn from a CSPRNG. 8 chars × 5 bits = **40 bits of entropy**, matches the spec floor. This is the secret — URL is capability, no other auth by default.

Why not plain UUIDs: unreadable, and when a client forwards the URL in a chat channel it looks like malware bait. Why not just the suffix: makes the URL more anonymous but destroys the operator's ability to eyeball "which engagement is this" in their shares list.

Guessability check: 40 bits with a per-slug rate limit (say 5 requests/minute/IP + 100/day/IP for `404`s) makes online enumeration infeasible. If we ever host high-volume, bump the suffix to 12 chars for 60 bits.

## 7. Expiry & revocation

- **Default: 30 days.** Picker at share time: 24h / 7d / 30d / 90d / never.
- **Never** is *(deferred)* — probably keep it out of v1; forcing an explicit re-share every 90 days is a feature.
- **My shared bundles** view (Settings ▸ 分享) lists active shares with `slug · created · expires · viewer count · [Revoke]`.
- Revoke = mark row `revoked=true`, hard-delete the object from R2 immediately, invalidate any cached signed download URL.
- On expiry: a scheduled Worker cron sweeps `expiresAt < now()`, hard-deletes the object, keeps the row for 30 more days flagged `expired` so the operator's list can show what was there.

## 8. Viewer experience

**v1: a single "Download bundle" page.** Static HTML rendered by the Worker showing: engagement slug, uploader operator name, created-at, expires-at, size, event count, chain-head hash, "Download bundle (87 MB)" button, "Verify chain locally with `redlog verify bundle.zip`" tip. No JavaScript-heavy replay UI.

v2: unzip in-browser, render sessions list, embed the chain-verify WASM, play `.cast` inline via asciinema-player.

v1 is the recommendation because the shape of the client-friendly viewer is the largest open UX question in this whole feature; shipping the download page first gets the primary use case (sending the pack) into operators' hands without committing to a design we'd rewrite.

## 9. Redaction gate (HARD requirement)

Upload button is **disabled** until the operator has seen a preview of what will leave their machine. The dialog contents:

```
This bundle will upload:
  • 4,812 events   (47 sanitized before upload)
  • 128 screenshots  (∑ 62 MB)
  • 6 asciinema .cast recordings (∑ 24 MB)
  • 12 quickmark loot entries
  • Chain head: 9c4a…d0e1  (last anchored 2026-07-31 09:00 UTC)

[ Show masked preview of the first 200 events ▸ ]

☐ I have reviewed what leaves this machine.
                                              [ Cancel ]  [ Upload → ]
```

The masked preview reuses the Timeline's redaction view (`text + redactions` spans) so the operator sees exactly what a viewer would see. The checkbox state is not remembered across sessions. This gate cannot be disabled by settings, cannot be skipped by CLI, and cannot be bypassed by a plugin.

## 10. Auth model

**Uploader** — device-bound short-lived tokens.

1. First-time share: operator enters an email, receives a magic link, clicks it in a browser → backend mints a **device token** bound to `{operatorEmail, deviceFingerprint}` (fingerprint = SHA-256 of Electron machine id + install nonce). Token lifetime 90 days, sliding.
2. Every `/api/share/*` call carries `Authorization: Bearer <device-token>`.
3. Rotating out a device = revoke from the web console.

**Viewer** — three modes, per-share:

- **Public link** (default): URL is the secret, no login. Best for one-shot handoffs to a client.
- **Email gate**: viewer enters an email address, backend mails a short-lived signed URL to it, that URL is what actually downloads. Prevents leaked-URL-in-Slack from being usable by an outsider.
- **Password**: uploader sets a passphrase, sent to the recipient out of band. Simple HMAC gate at the Worker.

## 11. Privacy / legal

**Backend logs, on the default hosted tier**:

- Upload: `sha256, bytes, engagementSlug, uploader operator id, upload IP truncated to /24 (v4) or /48 (v6), timestamp`. Kept 180 days for abuse response, then deleted.
- Downloads: `shareId, download IP truncated, user-agent family, timestamp, bytes served`. Kept 90 days.
- Bundle bytes: kept until expiry or revocation, whichever is first. Hard-deleted from R2 within 24 h; row retained per §7.

**GDPR delete-my-data**: authenticated endpoint `DELETE /api/account` — removes device tokens, share rows, and any objects still live. Response returns a receipt hash. Turnaround target: 72 h; documented in Terms.

**BYO-bucket tier**: only the share-URL registry row (or nothing, if the team self-hosts the KV too). No bundle bytes ever touch our infra.

## 12. Threat model

1. **Leaked share URL.** Someone forwards the link outside the intended audience. Mitigation: 40-bit suffix + rate limit on 404s, default 30-day expiry, revoke button, optional email/password gate.
2. **Backend compromise (R2 credentials / Worker secret).** Attacker gains read of all live bundles. Mitigation: bundles are sanitized before upload (§9), sanitize policy pinned per project, plaintext screenshots still leak. Mitigation v2: optional client-side symmetric encryption (Open Question 3).
3. **Sanitize bypass.** A plugin or a modified build uploads raw bytes labeled as sanitized. Mitigation: the sanitize pass runs in the same code path as `redlog-cli export bundle`, and the review gate cannot be disabled by settings, by the CLI or by a plugin (§9). **The Worker does not check sanitize counts** — it never parses `bundle.json`, so there is no server-side enforcement; the client-side gate is the whole of it. Since v0.11.0 the Worker does verify that uploaded bytes hash to the sha256 they are stored under, which detects corruption or substitution in flight but says nothing about whether the content was sanitized. *(Earlier revisions claimed the Worker rejected count mismatches. It never did.)*
4. **Malicious viewer / XSS in event body.** Any download-page or v2 inline-replay UI renders operator-controlled strings. Mitigation: viewer serves `Content-Security-Policy: default-src 'none'` for the download page; v2 replay MUST render event bodies as text, never as HTML, and MUST sandbox the asciinema player in a `srcdoc` iframe with `sandbox="allow-scripts"` (no `allow-same-origin`).
5. **Long-lived shares outliving the engagement.** Operator forgets a `90d` share; three months later the client's laptop is stolen with the URL in email. Mitigation: default 30d, weekly digest email to the uploader listing their active shares, "Revoke all shares older than N days" button.
6. **Uploader token theft.** Stolen device token uploads bundles under someone's name. Mitigation: 90-day sliding TTL, rotate-on-detection, mag-link rebinds fingerprint.
7. **Enumeration of shares by slug.** Guessing `/e/acme-external-2026q3-*`. Mitigation: rate-limit as above; suffix entropy makes it infeasible; consider optional slug-hashing for high-sensitivity engagements *(deferred)*.

## 13. Implementation phases

- **v1 MVP** — Share button; sanitize + preview gate; upload to R2 via signed URL; download page (no replay); `My shared bundles`; revoke; 30-day default expiry; magic-link uploader auth; public-link viewer only.
- **v2** — Inline replay: unzip in browser, sessions list, embedded chain-verify (WASM), asciinema player. Email-gate and password viewer modes. BYO-bucket config.
- **v3** — Team library: workspace shared across operators, per-share ACL, comment threads, per-viewer identity, audit log for viewer accesses. Programmatic upload via `redlog-cli share`.

## 14. Open questions

1. **Do we ship the default hosted tier at all?** Or launch BYO-bucket-only in v1 and let the RedLog project stay out of the data-custodian business until we have DPAs and a support SLA?
2. **Slug source of truth.** Engagement records don't currently have a URL-safe slug field. Add one at engagement create, or derive at share time from the engagement name + short hash?
3. **Client-side encryption.** Should v1 offer age-based symmetric encryption where the recipient's key is sent out of band? Adds a passphrase to the viewer flow but reduces the backend threat surface to ciphertext-only.
4. **Anchor status on the download page.** Should we surface "Chain-head anchor status: confirmed / pending / unconfirmed" prominently? It's the strongest tampering signal in the bundle and clients don't know to look for it.
5. **Retention for the *shares registry row* after hard-delete of the bytes.** Proposal is 30 days flagged `expired` so the operator can see history. Is that too long / too short from a privacy stance?
