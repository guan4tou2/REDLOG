# RedLog example plugin registry

An example marketplace index the operator can point RedLog at until (or
instead of) a "real" `plugins.redlog.dev` DNS-backed service exists. Serves as:

- a smoke-testable index that Settings ▸ 外掛市集 can actually fetch,
- a reference layout for anyone building their own private registry.

## Contents

- `index.json` — the manifest RedLog fetches. Lists every published plugin with
  its download URL, sha256, Ed25519 signature, and publisher metadata.
- `<id>-<version>.tar.gz` — the plugin bundles. Made with `tar -czf <id>.tar.gz <id>`.
- `redlog-example-keypair.json` (git-ignored) — private key used to sign the
  bundles in this example. **Not committed.** If you clone this repo and want to
  add a plugin, generate your own key:
  ```bash
  npx redlog-sign keygen --out my-keypair.json
  ```

## Pointing RedLog at this registry

In Settings ▸ 外掛市集, replace the default URL with:

```
https://raw.githubusercontent.com/guan4tou2/REDLOG/main/examples/registry/index.json
```

Fetch → three entries appear (`recon-pack`, `aider-hook`, `codex-hook`). All
three are 🟢 declarative — no privileged capabilities, no signature-required
gate. Install works even before you trust the `redlog-project` publisher; the
UI just shows a "publisher untrusted" warning.

To silence the warning, go to the Publishers sub-tab, paste in the public key
from `index.json` (the `publishers[0].keys[0].publicKey` field), and click Trust.

## Adding a plugin

1. Drop the plugin dir at the repo root of your registry (parallel to the
   existing ones).
2. `tar -czf my-plugin-1.0.0.tar.gz my-plugin`
3. Sign it:
   ```bash
   npx redlog-sign sign my-plugin-1.0.0.tar.gz \
     --key my-keypair.json \
     --id my-plugin --version 1.0.0 \
     --publisher my-org \
     --url https://<where-you-host>/my-plugin-1.0.0.tar.gz
   ```
4. Merge the printed JSON entry into `index.json`'s `entries` array.

## When you're ready for real DNS

- Set up your own hosting (GitHub Pages, S3, a static Worker, whatever).
- CNAME `plugins.redlog.dev` (or a subdomain of your own) to that hosting.
- Point RedLog's default marketplace URL at it via
  `src/renderer/src/components/Settings.tsx` `MarketplacePanel` placeholder or
  ship a build with a config default.

Until then, this example lives under GitHub raw and requires no infra beyond
this repo.
