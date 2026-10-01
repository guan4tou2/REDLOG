# Working in this repository

## Before you push

Run all four, in this order. `npm test` passing is not the bar — CI runs two
gates that Vitest does not, and both have caught real problems that a green
suite did not.

```bash
npm run typecheck && npm run verify:specs && npm run verify:architecture && npm test
```

The order is CI's, and it is deliberate:

- **typecheck** first, because a type error makes every test result suspect. It
  is also the guard Vitest cannot be: a name used but never imported typechecks
  as an error and *runs* as a `ReferenceError`. One such import went missing in
  the scope-recompute work and stopped capture for three commits.
- **verify:specs** — spec statuses are known, a Verified spec carries its tasks,
  plan and verification record, and the executable aliases are current.
- **verify:architecture** — every export is reachable from production code. This
  is how dead code is found here. Deleting a feature usually orphans something
  one file away from the thing you deleted, and nothing else will tell you.
- **npm test** last.

A green `npm test` with a red gate is the normal shape of this mistake, because
the gates check things tests structurally cannot.

### The known flake

The unit suite has an intermittent failure that lands on a **different file each
run**, passes in isolation, and shows up roughly once in ten. It is documented
in `.github/workflows/ci.yml`. If a failure matches that shape — a file you did
not touch, green on a re-run — it is this and not you. If it does not match that
shape, it is you.

## e2e

CI runs e2e on **ubuntu only**, which means two things:

- A spec can be POSIX-only without anyone noticing. Several use `#!/bin/sh`
  fixtures. If you are on Windows and one fails on its fixture rather than on
  the behaviour, make the spec say so with `test.skip(process.platform === 'win32', …)`
  rather than leaving it failing locally.
- e2e does **not** run when an earlier gate fails — it is skipped, not queued.
  A branch can therefore accumulate contract changes that e2e has never once
  checked. Run it yourself before a large branch goes up:

```bash
npm run build && npx playwright test e2e/<spec>.spec.ts --reporter=line
```

### Measuring geometry in e2e

The app renders at `body { zoom }` (default 0.9). `getBoundingClientRect()`
returns **device** pixels; `offsetLeft`, `offsetWidth` and `clientWidth` return
**CSS** pixels. Mixing them silently scales one side of a comparison by the zoom
factor — a dot at 1898 inside a 2000px track reads as 98px outside it. Pick one
family and stay in it; `offset*` is usually the one you want.

## Staging

Do not `git add -A` or `git add .`. Parallel sessions write to this checkout,
and both of this session's accidental commits of other people's work came from
staging everything. Name the paths.

## Changing behaviour

When a change replaces a contract rather than fixing a defect, the specs that
assert the old contract are part of the change — not follow-up work. e2e will
find them, but only after a full CI round trip, and only if the gates above let
it run.
