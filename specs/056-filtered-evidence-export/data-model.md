# Selection model

ExportSubset = all | time-range | selection. Selection contains projection events/http, EventFilter (target/type/time/scope/personal/tier), optional query text, HTTP predicates and optional excludeHousekeeping. Renderer cannot supply scope/private-domain policy. All predicates validated; nested objects cloned/frozen.

Snapshot contains rowid boundary per tier. Plan contains selected IDs/digest and exact counts; optional included exchange count differs from event count. The request itself is shown in preview and retained in manifest. Changing UI does not mutate a plan.

Bundle evidence metadata: kind complete-chain/projection, transformed event IDs, source boundary separately from delivered per-tier counts. No new database tables. Projection has original IDs/hash/prev_hash/signature; no synthesized chain. Whole casts are disclosed and may be excluded individually.
