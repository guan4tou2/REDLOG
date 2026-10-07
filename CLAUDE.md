# Working in this repository

## Before you push

Run all five, in this order. `npm test` passing is not the bar — CI runs three
gates that Vitest does not, and each has caught a real problem that a green
suite did not.

```bash
npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test
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
- **verify:i18n** — nothing in `test/` or `e2e/` asserts a UI string this branch
  deleted. Typecheck cannot see a string literal in a test, and the i18n key
  test checks the opposite direction, so until this existed the only thing that
  caught it was a full e2e round — six minutes in, and only when every gate
  before it was green. It compares against the merge base with `origin/main`,
  so a stale `origin/main` checks less than you think; `git fetch` first.
- **npm test** last.

A green `npm test` with a red gate is the normal shape of this mistake, because
the gates check things tests structurally cannot.

### A gate green on main may never have run

`verify:i18n` compares HEAD against its merge base with `origin/main`. On `main`
that base **is** HEAD, so it resolves trivially and passes on any checkout, however
shallow. On a branch it needs real history on **both** sides — and when it
shipped, `actions/checkout` was at its default `fetch-depth: 1`, so the branch
had one commit for that base to be found against. Green on main, red on every
PR, which is the only place it does any work.

Two things follow for any gate that compares against another ref:

- Judge it by a run on a **branch**. A green tick on `main` can mean the
  comparison was free.
- `--depth` on a fetch is not a cheaper `fetch-depth`. On a complete clone
  `git fetch --depth=N` makes that ref **shallow again** and takes the merge
  base back out. Deepen at the checkout, and leave `--depth` off the fetch.

### A skipped gate hides what is behind it

`e2e` is skipped, not queued, when an earlier gate fails — so a red gate is also
a blindfold. While the i18n gate was failing on every PR,
`e2e/screenshot-capture.spec.ts` was red on `main` and nobody saw it: there had
not been a completed e2e run to look at. Both halves of that were found in one
afternoon, and they were the same fault seen from two ends.

When a gate has been red for a while, assume the ones after it have been
reporting nothing, and read the first full run after the fix as new information
rather than a regression.

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

### A bare "Test timeout exceeded" names nothing — make it name something

A spec that fails with only `Test timeout of N exceeded`, no locator and no call
log, usually did **not** hang where the timeout says. The assertion failed, the
`finally` ran `await app.close()` against an app left in the broken state, the
close did not return, and the teardown ate the rest of the budget before the
real error could be reported. `Worker teardown timeout` beside it is the tell.

Do not start by bisecting the hang. Make the error speak first:

```ts
} catch (e) {
  console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
  throw e
} finally {
  await app.close()
}
```

Three separate real failures hid behind one bare timeout in
`managed-http-capture.spec.ts` for as long as nobody did this.

A fixture that outlives a signal makes the same mess: a `#!/bin/sh` loop around
`sleep` cannot act on SIGTERM until the current `sleep` returns, and leaves a
grandchild behind. `exec` the long-running command instead, so the stand-in is
one process that dies when it is told to.

### Measuring geometry in e2e

The app renders at `body { zoom }` (default 0.9). `getBoundingClientRect()`
returns **device** pixels; `offsetLeft`, `offsetWidth` and `clientWidth` return
**CSS** pixels. Mixing them silently scales one side of a comparison by the zoom
factor — a dot at 1898 inside a 2000px track reads as 98px outside it. Pick one
family and stay in it; `offset*` is usually the one you want.

## React

**Never declare a component inside another component's body.** A function
defined there is a new type on every render, so React unmounts and remounts its
entire subtree each time. Three things follow, and only the first is obvious:

- focus and state are lost on the keystroke that caused the render
- Fast Refresh cannot reconcile the old tree against the new one, so a panel
  renders part of itself and stops — which is how this was reported, not as a
  focus bug
- it is invisible in tests, because a test renders once

Declare them at module scope and pass what they closed over. `ExportMenu` had
three such components and shipped broken; the unit suite was green.

The same shape, different symptom: anything a component reads at render time
must exist before the render that reads it. This repo has been bitten by both
the TDZ version (a `const` below the JSX that uses it — see the contract note
in `Timeline.tsx`) and the stale-bridge version (a renderer calling a preload
method that the running window's preload predates; it needs a full reload, not
HMR).

## Staging

Do not `git add -A` or `git add .`. Parallel sessions write to this checkout,
and both of this session's accidental commits of other people's work came from
staging everything. Name the paths.

## Changing behaviour

When a change replaces a contract rather than fixing a defect, the specs that
assert the old contract are part of the change — not follow-up work. e2e will
find them, but only after a full CI round trip, and only if the gates above let
it run.
