#!/usr/bin/env bash
# c2-tailers: follow a Sliver session/beacon JSON log into RedLog's timeline.
#   Usage: sliver-tail.sh <path-to-sliver-json-log>
here="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$here/c2-tail.js" sliver "${1:?path to sliver json log required}"
