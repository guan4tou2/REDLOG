# redlog-share-worker

Cloudflare Worker + R2 + KV backend for the RedLog **cloud share bundle**
feature. Deploy this to **your own** Cloudflare account and point the RedLog
app at it via **Settings ▸ Cloud share ▸ Advanced: HTTPS backend**.

The RedLog project does not host a default tier. Every operator BYO-buckets;
sanitized evidence never leaves accounts you control. See
`../docs/CLOUD_SHARE_BUNDLE.md` §3 for the rationale.

---

## What you get after deploy

- `POST /api/share/init` — auth-checked, mints a signed short-lived PUT URL
  and a public share slug.
- `PUT  /api/share/put/<sha256>?token=…` — accepts the zip bytes into R2.
- `GET  /share/<slug>` — public HTML download page (inline CSS, CSP-locked,
  no external assets).
- `GET  /share/<slug>/download` — 302 to a fresh short-lived signed GET URL.
- `POST /api/share/revoke/<slug>` — auth-checked; hard-deletes the object
  and the KV row.
- `GET  /health` — uptime probe.

## Prerequisites

- Node 20+ (for the Wrangler CLI).
- A Cloudflare account with **R2 enabled** (free tier fits fine — see below).
- Wrangler installed globally or via `npx`:
  ```
  npm i -g wrangler        # or use `npx wrangler …` below
  ```

## One-time setup

```bash
cd redlog-share-worker

# 1. Authenticate wrangler.
wrangler login

# 2. Create the R2 bucket.
wrangler r2 bucket create redlog-bundles

# 3. Create the KV namespace and copy the printed `id` into wrangler.toml.
wrangler kv namespace create SHARES
# → paste the printed id into [[kv_namespaces]] id = "…" in wrangler.toml

# 4. Set the two secrets.
#    AUTH_TOKEN protects /api/share/init and /api/share/revoke.
#    SIGNING_KEY signs short-lived PUT/GET tokens; any long random string.
openssl rand -hex 32 | wrangler secret put AUTH_TOKEN
openssl rand -hex 32 | wrangler secret put SIGNING_KEY

# 5. Deploy.
npm install                # or: pnpm install / yarn install
wrangler deploy
```

Wrangler prints a URL like `https://redlog-share.<subdomain>.workers.dev`.
Sanity-check it:

```bash
curl -s https://redlog-share.<subdomain>.workers.dev/health
# → {"ok":true,"worker":"redlog-share","maxUploadMb":100}
```

## Point RedLog at your Worker

1. Open **RedLog ▸ Settings ▸ Cloud share (bundle)**.
2. Expand **Advanced: HTTPS backend**.
3. Endpoint URL: `https://redlog-share.<subdomain>.workers.dev`
4. Auth token: the string you passed to `AUTH_TOKEN`.
5. Select **Use HTTPS backend**, tick the redaction gate, click **Share**.

The client-side uploader (`src/core/cloud-share-uploader.ts` → `httpsUploader`)
issues a two-step upload:

```
POST /api/share/init  { sha256, sizeBytes, engagementId, expiresIn }
  → { putUrl, shareUrl, expiresAt }
PUT  {putUrl}   <zip bytes>
  → 200
```

The response `shareUrl` is what you copy-paste to the client.

## Configuration reference

| Setting | Where | Default | Notes |
|---|---|---|---|
| `RETENTION_ROW_DAYS` | `wrangler.toml [vars]` | `90` | Currently informational — KV rows expire with the object per §7. |
| `MAX_UPLOAD_MB`      | `wrangler.toml [vars]` | `100` | Hard reject on `sizeBytes >`. Bump if you upload larger bundles. |
| `PUBLIC_BASE_URL`    | `wrangler.toml [vars]` | (auto) | Set only if you front the Worker behind a custom domain and `request.url` no longer matches what operators use. |
| `AUTH_TOKEN`         | `wrangler secret put` | (required) | Shared bearer for `/api/share/init` and `/revoke`. |
| `SIGNING_KEY`        | `wrangler secret put` | (required) | HMAC key for short-lived PUT/GET URLs. Rotating invalidates in-flight uploads only — issued share URLs keep working. |

### Rotating `AUTH_TOKEN`

```bash
openssl rand -hex 32 | wrangler secret put AUTH_TOKEN
```

Old operators lose upload access immediately. Existing share URLs still
resolve (public URL-only auth, per spec §10).

### Revoking a share

```bash
curl -X POST \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  https://redlog-share.<subdomain>.workers.dev/api/share/revoke/<slug>
```

## Signing strategy (why we don't use S3 pre-signed URLs)

The Workers R2 binding does not expose a `createSignedUrl()` method as of
this Worker's `compatibility_date`. The alternatives are:

1. **Cloudflare-native option — sign our own tokens (chosen).** Both the PUT
   and GET endpoints live on the Worker; we mint a short-lived HMAC token
   scoped to a specific SHA-256, and the Worker calls the R2 binding on the
   client's behalf. Cloudflare does not charge for R2 egress or Workers
   ingress, so proxying is cost-equivalent to a direct S3 signed URL.
2. **AWS SigV4 against R2's S3 endpoint.** Works, but requires provisioning
   an R2 access key pair as extra secrets and shipping a SigV4 signer
   (~150 lines) inside the Worker. We prefer not to hand out S3 credentials
   to a Worker that never needs them.

If you do want direct-to-R2 uploads (e.g. to shave Worker CPU for
multi-GB bundles), swap `putBytes()` for a SigV4-signed `putUrl` — the wire
contract with the RedLog client (`{ putUrl, shareUrl, expiresAt }`) doesn't
change.

## Costs (Cloudflare free tier)

- **R2 storage:** 10 GB / month free. A typical 100 MB bundle × 100 shares
  = 10 GB.
- **R2 Class A ops (writes):** 1M / month free. One upload = one Class A op.
- **R2 Class B ops (reads):** 10M / month free. One download = a small
  number of Class B ops.
- **Workers requests:** 100K / day free (Workers Free), or 10M / month on
  Workers Paid ($5).
- **Egress bandwidth:** $0 forever — that's the whole point of R2.

Most solo operators and small teams fit inside the free tier. If you serve
a lot of downloads or store bundles for months, budget ~$0.015 / GB-month
for R2 storage overage.

## Local development

```bash
# Requires a preview KV namespace + preview R2 bucket configured in
# wrangler.toml (see the commented `preview_bucket_name` / `preview_id`).
wrangler dev
```

## Roadmap (not implemented in this Worker)

- Magic-link uploader auth per spec §10 (replaces the single shared
  `AUTH_TOKEN`). Marked as `TODO(magic-link)` in `src/index.ts`.
- Email-gate / password-gate viewer modes per spec §10.
- Scheduled `cron` sweep to hard-delete rows past `expiresAt +
  RETENTION_ROW_DAYS` (KV TTL handles the object-side today).
- BYO-bucket support that isn't Cloudflare R2 — spec §3 leaves an escape
  hatch for MinIO / S3 that this Worker doesn't cover.
