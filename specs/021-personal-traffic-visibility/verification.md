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

## 2026-09-23 clarification

Desktop flow now opens Loot through the command palette and verifies its shared
reveal/hide control. Tooltips explicitly describe target-based coverage and
untargeted/cast limitations. The full suite passes with 2,243 tests and 2
platform-specific skips; typecheck and production build pass.
