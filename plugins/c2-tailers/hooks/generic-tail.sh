#!/usr/bin/env bash
# c2-tailers: follow a generic RedLog-C2 JSONL log into RedLog's timeline.
#   Usage: generic-tail.sh <path-to-jsonl-log>
here="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$here/c2-tail.js" generic "${1:?path to jsonl log required}"
