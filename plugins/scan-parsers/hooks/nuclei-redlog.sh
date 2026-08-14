#!/usr/bin/env bash
# scan-parsers: run nuclei and capture each finding into RedLog's timeline.
# JSONL output is piped through the parser, which echoes it back so you still
# see the stream.
#   Usage: nuclei-redlog.sh <normal nuclei args>   e.g.  nuclei-redlog.sh -u https://x.example.com
here="$(cd "$(dirname "$0")/.." && pwd)"
exec nuclei -jsonl "$@" | node "$here/scan-to-redlog.js" nuclei
