# Verification: Personal Traffic Visibility

## Automated checks

- `npm run typecheck`
- Focused Vitest coverage for persistence, shared-filter wiring, renderer,
  Search, Transcript, HTTP flows, Loot, and i18n
- `npm run build`
- `npx playwright test e2e/personal-traffic-visibility.spec.ts`
- `npm test`
- `npm run verify:specs`

## Observable behavior

- A work target remains visible while a localhost event with the same search
  term is hidden by default.
- The **Non-work hidden** chip reveals the localhost event in one click and
  changes to **Non-work visible**.
- Untargeted rows and terminal cast search remain visible.
- Filtering happens in persistence before page limits; stored rows and export
  policy are unchanged.
