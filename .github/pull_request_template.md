## What changed

<!-- One paragraph: what is different, and for whom. -->

## Why

<!-- The problem. Link the issue or the doc section that argues for it. -->

## Verification

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run e2e` if the change is visible in the app

---

**UI/UX work?** Use the phase template that matches the change — GitHub has no
picker for these, so append the query string to the compare URL:

- `?template=phase1-tokens.md` — tokens, type scale, spacing, colour
- `?template=phase2-behaviour.md` — interaction, keyboard, states, copy
- `?template=phase3-structure.md` — layout, responsiveness, virtualisation

The rules they check are in [`docs/UIUX-STANDARD.md`](../docs/UIUX-STANDARD.md).
