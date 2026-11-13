// What a row's `data` says about the thing it recorded, without the receiver's
// stamp. Every new row carries `data._ingest` (Spec 071 FR-005), and its
// event_id is different on every row, so a reader that compares, counts or
// lists the whole of `data` would see two deliveries of one command as
// different and an otherwise empty row as having content. Readers that judge
// content go through here; readers that show the stored row (the raw JSON
// view) do not.

/** `data` without `_ingest`. */
export function sourceContent(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!data) return {}
  if (!Object.prototype.hasOwnProperty.call(data, '_ingest')) return data
  const { _ingest: _stamp, ...rest } = data
  return rest
}

/** Whether two rows recorded the same thing: their data equal but for the stamp. */
export function sameSourceContent(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  return JSON.stringify(sourceContent(a)) === JSON.stringify(sourceContent(b))
}
