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

The workflow will:
1. Run tests on macOS and Windows runners
2. Rebuild `better-sqlite3` for the target Electron runtime
3. Build renderer + main via `electron-vite build`
4. Package with `electron-builder`:
   - **macOS**: `dmg` and `zip` for x64 + arm64
   - **Windows**: `nsis` installer + `portable` .exe for x64
5. Upload artifacts to the GitHub Release matching the tag
6. Sign artifacts with GitHub's OIDC token (unsigned macOS/Windows binaries — no Apple/Microsoft cert)

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
npm run rebuild && npm run build && npx electron-builder --mac --publish never

# Windows (on Windows)
npm run rebuild && npm run build && npx electron-builder --win --publish never
```

Output ends up in `dist/`.

## Version bump checklist

- [ ] `package.json` → `version`
- [ ] `README.md` badge/version reference (if any)
- [ ] Commit + push
- [ ] `git tag -a vX.Y.Z -m "..."`
- [ ] `git push origin vX.Y.Z`
- [ ] Watch the Actions run; verify artifacts appear on the Release page
