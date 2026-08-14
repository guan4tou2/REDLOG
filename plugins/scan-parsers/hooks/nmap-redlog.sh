#!/usr/bin/env bash
# scan-parsers: run nmap and capture its results into RedLog's timeline.
# Greppable output (-oG -) is piped through the parser, which echoes it back so
# you still see it. Your other -o flags (-oN/-oX to files) are unaffected.
#   Usage: nmap-redlog.sh <normal nmap args>   e.g.  nmap-redlog.sh -sV 10.0.0.0/24
here="$(cd "$(dirname "$0")/.." && pwd)"
exec nmap -oG - "$@" | node "$here/scan-to-redlog.js" nmap
