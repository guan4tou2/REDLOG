// A shared filter chip that a page cannot honour must say so on that page.
//
// The FilterBar is global, so its chips keep reading as active on every view.
// Where a view narrows the data by construction — HTTP History only holds
// scanner-sourced HTTP flows, the Transcript only buckets the types it knows —
// a chip the view ignores produced results that looked filtered and were not,
// or an empty screen indistinguishable from "no such events". Both are wrong
// answers to an investigation question, so the unapplied condition is stated
// where the operator is looking rather than left to be inferred.
//
// Same amber "this is not the whole answer" treatment as the Search panel's
// partial-failure warning: it reports a state, so it is not clickable and
// never red, which is reserved for failure.
export function UnappliedFilterNotice({ title, reason }: {
  /** Which condition is not in effect here. */
  title: string
  /** Why this view cannot apply it. The reason, not a restatement. */
  reason: string
}): JSX.Element {
  return (
    <div
      data-testid="unapplied-filter-notice"
      role="status"
      className="mx-3 my-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-redlog-text-dim">{reason}</div>
    </div>
  )
}
