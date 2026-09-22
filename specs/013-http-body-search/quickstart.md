# Validation Quickstart

1. Ingest a response whose unique marker lies in an externalized text body.
2. Search the marker and confirm the response event is returned.
3. Confirm target/time/source filters and pagination apply before the limit.
4. Confirm a metadata+body match appears once.
5. Evict the body, prune the index and confirm the marker no longer matches.
