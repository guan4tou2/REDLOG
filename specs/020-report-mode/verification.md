# Verification: Report Mode

## Automated checks

- `npm run typecheck`
- `npx vitest run test/event-bus.test.ts test/renderer-smoke.test.tsx`
- `npm run build`
- `npm run verify:specs`
- `npx playwright test e2e/report-mode.spec.ts`
- `npm test`

## Observable behavior

- The title bar exposes one explicit **Write report** action and changes it to
  **Resume recording** while active.
- Status Bar reports `REPORTING` separately from a manual `PAUSED` state.
- Re-entering the current mode is a no-op and cannot create duplicate audit
  boundaries.
- An external event submitted during report mode receives the normal paused
  response and is absent from search.
- Search and export-plan resolution remain callable during report mode.
- Leaving the mode writes `report_mode_started` and `report_mode_ended` chained
  events around the gap.
