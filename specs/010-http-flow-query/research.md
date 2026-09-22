# Research: HTTP Flow Query

## Decision: page flow heads, then fetch members

Paging individual rows can separate a request from its response. Flow heads
provide stable ordering and selection; a second query returns all captured
members for the selected flow IDs.

## Decision: request start defines selection time

Request time matches what the operator initiated. If capture started after the
request, the earliest surviving row keeps the incomplete flow discoverable.
