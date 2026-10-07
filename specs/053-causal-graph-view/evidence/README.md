# Evidence for Spec 053

Kept because two of this spec's decisions rest on measurements rather than on
judgement, and a measurement nobody can reproduce is an assertion. Point-in-time
artifacts: they record what was true on 2026-10-05, not what is true now.

## causal-graph-spike.html

Open it in any browser — one file, no build, no dependencies, nothing fetched
from a CDN. It is the apparatus behind the table in `spec.md`
(*Why dagre, and why not React Flow*).

The page applies RedLog's own `body { zoom: var(--app-zoom, 0.9) }`
(`styles/index.css:270`) and offers the four steps of the `lib/uiScale` ladder,
so every reading is taken under the real condition. Two panels:

1. **The look** — a hand-laid DAG of a plausible lateral-movement chain, which
   is what the graph was first sketched as. The layout here is a throwaway
   ranking function; the shipped one is dagre.
2. **The diagnostic** — the part that matters. Move the pointer across the grid
   and the page draws a crosshair at the coordinate `d3.pointer()` would
   compute (`clientX − getBoundingClientRect().left`), beside the browser's own
   `offsetX`. It reports `rect.width ÷ offsetWidth` and the drift between the
   two, live, at each UI scale.

What it established, on Chromium 152:

| `--app-zoom` | `rect.width` ÷ `offsetWidth` | 100px CSS `translateX` observed as |
|---|---|---|
| 0.9 | 0.8998 | 90.0 client px |
| 0.99 | 0.99 | 99.0 |
| 1.125 | 1.1246 | 112.5 |
| 1.26 | 1.2605 | 126.0 |

Under CSS `zoom` the two unit systems differ by exactly the zoom factor. A
library that reads a pointer delta in client pixels and writes it back as a CSS
pixel transform — which is what d3-zoom and React Flow do together — therefore
moves the canvas at `delta × zoom` while the cursor moved `delta`.

The page is worth keeping past this spec: **any** future dependency that does
pointer maths against `getBoundingClientRect()` can be checked with it in about
a minute, and the answer will not be obvious from the library's own docs.

## Screenshots

Taken from the running Electron app over CDP, against a real project, not from
the spike.

| File | What it shows |
|---|---|
| `linear-chain-right-dock.png` | A two-node chain in the right-docked pane: anchor ring, cause above it, lane named in the meta line. The intended reading position. |
| `linear-chain-bottom-dock.png` | The same chain with the pane docked at the bottom, where the pane is short enough to cut the graph off. |
| `branch-overflow-before.png` | The defect the unit suite could not see. A request with both a response and a scope violation hanging off it: a rank of two 186px nodes came to 414px against a 396px pane, clipping the second node and raising a horizontal scrollbar. |
| `branch-overflow-after.png` | The same component at 172px nodes — 386px, no scrollbar. |

The before/after pair is why the second commit on this branch exists. A test
does not know how wide the pane is, so nothing but running it would have found
this.

## Reproducing the screenshots

The app cannot be driven from an ordinary browser tab — without the Electron
preload, `App.tsx` throws on `window.redlog.project` and `#root` stays empty.
Launch with `npx electron-vite dev -- --remote-debugging-port=9223` and drive
the renderer over CDP. `http://127.0.0.1:9223/json/list` returns two page
targets and lists the HUD overlay **first**; select the one whose URL is not
`overlay.html`, or you will be talking to a window whose preload exposes a
different, much smaller bridge.
