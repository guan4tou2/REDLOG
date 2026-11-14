// The target a request body names for its row (`target_id`, or `targetId`),
// read the one way for every door that carries a body: POST /api/events and a
// spool file (Spec 071 FR-093). It wins over a target ingest extracts from the
// content, because ingest extracts only when no target was given.
//
// The reading is the API's as it has always been: the first truthy of the two
// keys, unvalidated. pcap-agent.py sets it to the packet's destination and
// mitmproxy-addon.py to the request's host.

import { fieldText } from './field-text'

export function bodyTargetId(body: Record<string, unknown>): string | undefined {
  // A target that is not a scalar is no target (./field-text.ts): a nested
  // array here was stringified recursively further on.
  return fieldText(body.target_id || body.targetId || undefined)
}
