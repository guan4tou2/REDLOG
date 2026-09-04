# Releasing

RedLog releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml). Pushing a `v*` tag to `main` triggers a cross-platform build that packages installers and attaches them to a GitHub Release.

## Cutting a release

```bash
# 1. Bump version in package.json (e.g. 0.1.0 → 0.2.0)
#    Commit the bump alongside a CHANGELOG entry if you keep one.

# 2. Tag and push
git tag -a v0.2.0 -m "v0.2.0 — <one-liner>"
git push origin main
git push origin v0.2.0
```

The workflow has two phases:

**build** (matrix macOS + Windows, in parallel):
1. Run tests on each runner (against Node ABI — the default `npm ci` install)
2. Build renderer + main via `electron-vite build`
3. Package with `electron-builder --publish never` — it rebuilds native modules (better-sqlite3, node-pty) against the target Electron ABI automatically during packaging, using prebuilt binaries where available:
   - **macOS**: `dmg` and `zip` for arm64 only — `electron-builder.yml` has said Apple Silicon only since v0.9.4, and says why in its own comment
   - **Windows**: `nsis` installer + `portable` .exe for x64
4. Upload the installers as workflow artifacts

**release** (single job, after both builds):
5. Download every platform's artifacts and create **one** GitHub Release with all of them via `softprops/action-gh-release`

> The build jobs deliberately do NOT publish. Two concurrent `electron-builder --publish always` jobs race to create the release and produce two release objects for one tag — which is how v0.2.1 first shipped mac-only. Collecting artifacts and releasing once avoids the race entirely.

Unsigned macOS/Windows binaries — no Apple/Microsoft cert configured.

## Manual trigger

The `workflow_dispatch` input lets you re-run for an existing tag from the Actions tab. The tag must already exist on `main`.

## Signing (not enabled)

Neither macOS nor Windows binaries are code-signed. Consequences:

- **macOS**: users must right-click → Open on first launch (Gatekeeper warning)
- **Windows**: SmartScreen may block; users see "Unknown publisher"

To enable signing, add these secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY: false`:
- `CSC_LINK` + `CSC_KEY_PASSWORD` (macOS Apple Developer .p12)
- `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (Windows Authenticode .pfx)

## Local dry-run

```bash
# macOS (on a Mac)
npm run build && npx electron-builder --mac --publish never

# Windows (on Windows)
npm run build && npx electron-builder --win --publish never
```

Output ends up in `dist/`. electron-builder rebuilds native modules for the target Electron ABI internally — you do NOT need to run `npm run rebuild` first (that script is only useful when running `electron-vite dev` locally so better-sqlite3 loads inside the dev-mode Electron process).

**Gotcha:** because electron-builder recompiles `better-sqlite3` in `node_modules/` for Electron's ABI, `npm test` fails with `NODE_MODULE_VERSION` mismatch after any local packaging run. Restore the Node build before testing again:

```bash
npm rebuild better-sqlite3
```

CI is unaffected — the workflow runs tests before packaging.

## Version bump checklist

- [ ] `package.json` → `version`
- [ ] `README.md` badge/version reference (if any)
- [ ] Commit + push
- [ ] `git tag -a vX.Y.Z -m "..."`
- [ ] `git push origin vX.Y.Z`
- [ ] Watch the Actions run; verify artifacts appear on the Release page
