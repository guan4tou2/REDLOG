# Quickstart: One Retention Model

1. Open Settings ▸ Capture, set the cast store budget to 100 MB, save, and
   confirm the project's `config.yaml` has `retention.casts.maxBytes: 104857600`
   and no `terminal.castStoreMaxBytes`.
2. Set `retention.casts.keepDays: 1` in `config.yaml`, reopen the project with
   a cast older than a day, and confirm a `system.cast_pruned` row.
