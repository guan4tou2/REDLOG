# Research: Search Result Integrity

## Decision: preserve independent source state

Event FTS and `.cast` index queries can fail independently. One aggregate error
would hide whether visible results are complete, so the surface keeps primary
failure and secondary partial failure distinct.

## Decision: retry the current intent

Retry invokes the existing search callback against the current query reference.
The shared filter callback remains unchanged, preserving the operator's context.
