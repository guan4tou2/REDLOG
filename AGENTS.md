# Agent instructions

`CLAUDE.md` remains the source of truth for verification, e2e and git workflow.
The rules below are additional and apply to every agent working in this repo.

## UI: let the layout explain

Avoid unnecessary secondary labels and descriptions.
Let the layout do the explaining.
請謹慎使用程式碼。

- Do not add a subtitle, helper line, caption, tooltip or info box when the
  heading, control or layout already makes the meaning clear.
- Do not restate the page title in a description. No slogans, marketing copy or
  "how to use this screen" paragraphs.
- Prefer hierarchy, spacing, grouping and state (selected, disabled, empty,
  loading) over prose.
- Do not default to the "icon + title + description + card" stack. A
  description is justified only when it carries information the title cannot.
- No section heading for a single item, and no card, border or divider added
  only to compensate for weak grouping.
- Keep accessible names (`aria-label`, `sr-only`) when visible copy is removed.
- Keep short, specific copy for errors, destructive confirmations, security
  boundaries and empty states. Deleting a required warning is not simplification.
- When in doubt, remove the text and check whether the screen still reads.

`docs/UIUX-CONTROLS-AND-COPY.md` §2 is the necessity test; `docs/UIUX-STANDARD.md`
holds the empty-state and settings conventions.

`test/ui-copy.test.ts` is the mechanical half of this rule and runs in CI. It
fails on: the same explanation stored under two keys, a descriptive key nothing
renders, a hint that only repeats its label, a tooltip that repeats the visible
text beside it, and a helper line over three sentences without being on its
allow-list of warnings. It runs against both locales. It cannot judge whether a
sentence is *worth* saying — that is §2's four questions — so it only catches
the shapes that are never right. If it fails, fix the copy; do not add to the
allow-list unless the string states a consequence the operator must know before
acting.

The same file records which layout patterns were measured and ruled out (nested
cards, heading-plus-repeating-paragraph, icon buttons whose tooltip is their
label), so that ground is not re-dug. Do not add a layout gate without checking
that list first: each candidate there was inspected and found legitimate.

`請謹慎使用程式碼` also applies to implementation: make the smallest change that
satisfies the behaviour. Do not add components, props, state or dependencies
whose only purpose is to render copy that should not exist.

## Launching Electron from an agent sandbox

Electron cannot start inside Codex/ChatGPT's Seatbelt sandbox. `NSApplication`
initialization reaches `_RegisterApplication`, which aborts with SIGABRT before
`out/main/index.js` runs.

Any command that launches the Electron GUI — `npm run dev`, `npm run e2e`,
`npx playwright test`, or the `Electron.app` binary directly — must run with
`sandbox_permissions: "require_escalated"` when invoked by Codex. Treat the
resulting crash report as an environment failure, not an app bug.

A normal Terminal session needs no special flag. Do not switch the global
sandbox to `danger-full-access` to work around this.
