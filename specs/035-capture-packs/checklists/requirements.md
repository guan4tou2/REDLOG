# Requirements Checklist: Capture Packs

- [x] Each FR has an observable, tested outcome (config, gating, health, UI).
- [x] The failure direction of the key removal is stated: an old config stops
      recording a source until its pack is on — in the CHANGELOG upgrade notes.
- [x] Essential capture does not depend on any pack (FR-003).
- [x] Secret masking and scope are explicitly not packs.
- [x] The pack's plugin-disabled state is visible where the switch would be.
