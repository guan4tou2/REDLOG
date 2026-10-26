# Whole-app visual refinement — 2026-10-26

Status: first-batch implementation and bounded verification complete; full native live-resize acceptance pending. Local worktree only; no commit/push/release.

## Subsequent product decision

The later recording-first workspace specification [Spec 064](../064-recording-first-workspace/spec.md)
supersedes the fixed eleven-entry navigation and visual-first sequencing below.
Keep the historical implementation/acceptance evidence; it does not prove the
new Activity/I/O/conversation workspace or five-entry navigation is implemented.

## Scope and sequence

The user confirmed **Forensic Editorial / Obsidian Red** for the complete
Electron app, including all 11 work views plus Settings and system surfaces.
The current full-product requirements and acceptance matrix are maintained in
[UIUX-FORENSIC-EDITORIAL.md](../../docs/UIUX-FORENSIC-EDITORIAL.md). The sequence
below records the earlier bounded source-row increment; subsequent planning follows Spec 064 and its recording-first acceptance gates.


User selected the whole App in batches. Preserve RedLog as a recording tool,
external-terminal-first, optional integrations, default-on IP HUD, original
source evidence and the shared query/export contracts. No new product surfaces,
marketplace, capture modes or data migrations are required for this visual work.

1. Terminal settings and connection: shorter source rows, consistent actions,
   the connection steps adjacent to the selected source, and stable controls
   while revalidating. Existing output proof remains visible.
2. Remaining settings and sources: use the same alignment and hierarchy; verify
   optional-provider install/enable states, field search and recovery.
3. Investigation views: navigation, filters, tables, detail panes and long
   evidence across dashboard/search/transcript/HTTP/targets/screenshots/bookmarks.
4. Export and marker dialogs: readable selection, reachable actions, focus,
   completion and reopening the actual artifact.

## Review dimensions

| Dimension | Observable acceptance |
| --- | --- |
| Typography | Existing bundled fonts and type scale; clear title/value/body hierarchy; command/IP/path text remains readable and selectable where needed. |
| Whitespace | Spacing uses existing density tokens; no accidental width cap on source lists, overflow or empty card height forced by action placement. |
| Hierarchy | Selected source and its pending work stay associated; one primary action in each action group; warnings stay with the affected action. |
| Color | Existing neutral/accent/state tokens, readable contrast, statuses never rely on color alone. |
| Motion | Feedback may clarify state changes; no decorative looping motion while recording; reduced-motion preference remains effective. |
| Micro-interaction | Keyboard focus visible, async actions stable, no reinstallation on ordinary focus refresh, loading/error/success distinguishable. |
| Responsive | Native wide/narrow inspection plus the existing 800/1600 geometry checks; both locales, larger scale, long content and reachable actions. Electron desktop is the shipped surface; mobile web support is not implied. |
| Originality | Preserve RedLog's recording/evidence identity and restrained visual language. No generic marketing-page treatment or new decorative dashboard. This is a design judgment, not an automated score. |

Awwwards/Webby/FWA are aspirational references provided by the user, not an
award or an objective pass/fail bar. No claim of a complete visual comparison
with winning entries: the reference listings did not provide inspectable
screens in this session. Actual review must use current RedLog screens and
observable problems. No finite review can certify that no possible visual
improvement remains; record known defects, fixed scope and unchecked states.

## First batch

Changes: reuse Button for source actions, bring name/state/actions together,
use full-width source rows for connection steps, and expose
expanded state. No extra descriptions, icons, props or dependencies were added.
Existing privacy-boundary copy remains.

The ready-dist installed acceptance predates this batch. Its successful capture
checks are recorded separately in verification.md. Native images sometimes
showed an earlier surface after resize while accessibility had updated; therefore
source geometry tests must not be described as manual visual acceptance.

Verification results are appended after the relevant runs finish.


Native source review caught a visual issue in the first attempt: a full-span
connection row kept the auto-fit grid's otherwise empty tracks alive, leaving
small sibling cards and a large blank area. Replaced that layout with compact,
full-width source rows. Name/state and actions wrap at narrow widths, with the
connection directly below its source header. No extra layout component was added.
The intermediate grid screenshot is not the accepted final layout.


## Final first-batch verification

- Typecheck and build passed after the final row-layout repair.
- Spec, architecture and i18n gates passed; focused panel/platform/copy units:
  17 passed in the existing three files.
- Existing Electron settings geometry and source-to-export connection cases:
  2 passed. Both locales, 800/1600 window widths and 1/1.5/2 Electron zoom are
  exercised by the geometry case. The source case also verifies the command
  nonce remains unchanged after focus revalidation and actual Zsh command and
  output proof arrive through the installed adapter.
- Native source UI: after reloading the same isolated window, the final
  full-width list and expanded Zsh connection were visually inspected in the
  smaller window. Buttons, command/copy and later source rows stayed inside
  the content edge. Warp was retained. This is source-build evidence, not a
  new DMG acceptance.
- Native wide resize still produced stale capture surfaces. Do not mark that
  visual check passed, and do not describe 800/1600 automation as manual QA.
  The reliable smaller screenshot does not erase that outstanding limitation.
- Normal native quit returned exit 0. Restored the source Node SQLite binding
  after Electron tests. No personal profile, dependency install or CA change.

T087 remains unchecked for its reliable native wide-view review. T085 and
T008–T013 remain open. T088–T090 are subsequent requested batches, not yet
implemented by this first-batch change. No new full-suite/CI claim, packaging,
commit, push or release was performed for this visual increment.
