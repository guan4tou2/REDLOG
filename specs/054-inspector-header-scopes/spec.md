# Feature Specification: What Belongs in the Inspector's Header

**Feature Branch**: `054-inspector-header-scopes`

**Created**: 2026-10-07

**Status**: Draft

**Input**: The Timeline inspector's pane header carries two controls that act
on things other than the pane — `這筆前後的事件`, which rewrites the shared
Timeline filter, and `匯出時排除`, which writes to the project database. Its
sibling pane, the HTTP log, carries neither. The question this spec answers is
not "are these controls good" — both earn their place in the product — but
"does a pane header say what this pane does, or what this event does".

## Background

`TimelineEventInspector`'s header is one flex row with three groups in it:

| Group | Controls | Acts on |
|---|---|---|
| Identity | lane dot, `SCANNER`, operator chip, tier badge | the selected row |
| Event / view actions | `這筆前後的事件`, `匯出時排除` | the Timeline filter; the database |
| Pane controls | `‹ ›`, dock `▣`, close `✕` | this pane |

The HTTP log's detail header (`HttpHistoryPanel.tsx`) has a title, `‹ ›`, dock
and close — pane controls only. `TimelineEventInspector.tsx`'s own comment says
dock and close live there "matching the HTTP log". The two panes have since
diverged, and only one of them grew a middle group.

### What the two controls actually do

- **`這筆前後的事件`** → `onAround` → `setSharedTimeRange(windowAround(ts))`,
  a ±5 minute window centred on the event (`lib/timeRangeInput.ts:57`). The
  code comment is right about why it exists: *"What else was happening when
  this ran" is the commonest next question about an event, and there was no way
  to ask it: the bar offered only windows ending now.* The filter panel offers
  `1 小時 / 6 小時 / 24 小時 / 全部時間` and two datetime fields; none of them
  centres on a row. This is the only affordance for that question and it is
  one click. It stays.

- **`匯出時排除`** → `toggleDoNotExport(id)` → one row inserted into or deleted
  from `do_not_export` (`src/core/db/do-not-export.ts`). It does not touch the
  event or the hash chain; export consults the table. Reversible, and the
  button carries its own state (red when set). It stays too.

Both pass §25's necessity test. Neither is the problem.

## The problem

**Scope.** A pane header is the place a reader looks to ask "what can I do with
this panel". Two of its six controls answer a different question, and they do
not even answer the same one as each other: one changes what the whole Timeline
shows, the other changes what will leave the building.

**Blast radius beside a close button.** `匯出時排除` is the only control in that
row that writes persistent state, and it sits two positions from `✕`. The cost
of a misclick is not "I closed a panel" but "an event silently left, or
silently stopped leaving, the client deliverable". It is recoverable and it is
visible, so this is a question of distance, not of danger tier.

**§5-5 wants a Toast.** The rule reads 可逆 → 直接執行 + Toast 附復原. This
toggle executes directly and shows no Toast; the red state on the button is its
only feedback. That is arguably better than a transient Toast, because the
state persists where the Toast would not — but the divergence is undeclared,
and §23 is where declared divergences live.

**Width.** The header already carries a long comment about wrapping: beside the
list the pane is 440px by default and 280px at its narrowest, and a
non-wrapping row put `Exclude from export` at one letter per line and 匯出時排除
at one character per line. The two labels in question are the widest items in
the row. Moving them is also the cheapest fix for the wrap.

## Requirements *(mandatory)*

- **FR-001**: The inspector's pane header MUST carry only identity and pane
  controls. "Pane controls" are the ones whose effect ends when the pane
  closes: step, dock, close.
- **FR-002**: `這筆前後的事件` MUST move to the event's own time, so a control
  that sets a window around a timestamp sits beside the timestamp it is about.
- **FR-003**: `匯出時排除` MUST move out of the header and MUST NOT be adjacent
  to `✕`. It belongs with the material about the deliverable — next to the note
  field at the foot of the pane is the candidate, since both are the operator's
  own annotations rather than observations.
- **FR-004**: Both MUST keep their text labels. §25: 破壞性動作永遠有文字, and
  neither is used often enough per engagement to earn icon-only form.
- **FR-005**: The two panes MUST converge, not diverge further: after this
  change the inspector's header and the HTTP log's header MUST carry the same
  kinds of control.
- **FR-006**: The §5-5 divergence MUST be resolved either by adding the Toast
  or by recording the state-on-the-control alternative in UIUX-STANDARD §23.
  Leaving it undeclared is what this requirement forbids.
- **FR-007**: The existing `data-testid`s (`detail-around-event`,
  `timeline-layout-toggle`, `timeline-detail-close`, `detail-step-prev/next`)
  MUST survive the move. e2e asserts on them; a rename is a separate change
  with its own reason.

## Non-Goals

- **Removing either control.** Both answer a real question and nothing else
  answers it.
- **Changing what they do.** `windowAround`'s ±5 minutes and the
  `do_not_export` table are out of scope; this is about where the controls sit.
- **Restyling the header.** The wrap behaviour stays as it is; it should simply
  have less to wrap.

## Scenarios

### Scenario 1 — The header answers one question

```
Given  an event is selected and the pane is docked right
When   the operator reads the pane header
Then   every control in it acts on the pane or names the row,
       and none of them writes to the project or moves the Timeline
```

### Scenario 2 — Excluding from export is not a neighbour of close

```
Given  the inspector is open
Then   no control that writes persistent state is adjacent to `✕`
```

### Scenario 3 — The two detail panes agree

```
Given  the Timeline inspector and the HTTP log detail pane
When   their headers are compared
Then   both carry identity plus step / dock / close, and nothing else
```

## Open Questions

1. **Does `匯出時排除` belong at the foot, or in a `⋯` menu?** The foot keeps it
   visible and groups it with the note; a menu hides a control an operator may
   want to find quickly while assembling a deliverable. FR-003 names the foot
   as the candidate, not the decision.
2. **Should `這筆前後的事件` keep its label once it sits beside the time?**
   Beside a timestamp it could read as a shorter verb. §25 says frequency
   decides form, and nobody has counted how often this is pressed in an
   engagement.
3. **Is a rule test worth it?** §21 puts rules like this in CI. "No control in
   a pane header writes persistent state" is hard to express as a source regex;
   "the header contains no button whose handler names `toggle`" is expressible
   but weak. Possibly not worth the false confidence.

## Notes

The inspector's header gained these controls honestly — each was the smallest
place to put a thing that needed to exist. This spec is not a complaint about
either decision. It is the observation that a header is a scope, and that two
controls crossed it one at a time, which is how a header stops being readable
without any single change being wrong.
