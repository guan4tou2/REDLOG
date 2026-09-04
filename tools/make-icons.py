#!/usr/bin/env python3
"""Regenerate every shipped icon from the two design masters.

The masters live in design/assets/ and come from the Claude Design project
(docs/UIUX-STANDARD.md section 16). Nothing under resources/ is hand-edited —
run this script instead, and commit what it writes.

    python3 tools/make-icons.py            # write the files
    python3 tools/make-icons.py --check    # exit 1 if anything is stale

Needs rsvg-convert (brew install librsvg). .icns additionally needs macOS
(iconutil); on other platforms the existing .icns is left alone and the script
says so rather than silently shipping a stale one.

Two things here are decisions, not arithmetic, and both were made by looking at
the actual pixels — see docs/UIUX-STANDARD.md section 16 for the record:

1. RING_MIN_PX. The full mark's ring is 45% of the icon's width and 16% of that
   again in stroke, so at 16px the stroke lands on 1.15 pixels and the ring, the
   gap and the centre dot all blur into one grey smudge. Below 32px we render
   the small master instead, where the ring has already collapsed to a solid dot.

2. The tray glyph is NOT the mark. A macOS template image is drawn from its
   alpha channel alone, and the mark's plate is opaque everywhere — ring, dot
   and all — so as a template it renders as one solid black tile with no ring
   visible at all. The menu bar therefore gets its own artwork: the ring and dot
   with no plate behind them, which is also what every other menu-bar icon does.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASTER_RING = ROOT / 'design' / 'assets' / 'redlog-mark.svg'
MASTER_DOT = ROOT / 'design' / 'assets' / 'redlog-mark-small.svg'
RESOURCES = ROOT / 'resources'
RENDERER_ASSETS = ROOT / 'src' / 'renderer' / 'src' / 'assets'

# Below this the ring is unreadable; use the collapsed-dot master instead.
RING_MIN_PX = 32

APP_PNG_SIZES = [16, 32, 64, 128, 256, 512, 1024]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

MARK_RED = '#d75f63'

# Tray glyph geometry, on a 16x16 canvas. The numbers are snapped to whole and
# half pixels on purpose: the ring's outer edge lands exactly on r=6 and its
# inner edge on r=4, so at 1x the ring, the gap and the dot each get whole
# pixels instead of straddling boundaries. That costs 0.67pt of ring width and
# 3.3pt of dot diameter against the section 16 ratios (16% / 30% of the outer
# diameter) and buys a glyph that is still legible on a non-Retina menu bar.
TRAY_CANVAS = 16
TRAY_RING_R = 5.0
TRAY_RING_W = 2.0
TRAY_DOT_R = 2.0
TRAY_PAUSED_OPACITY = 0.45


def tray_svg(colour: str, opacity: float = 1.0) -> str:
    o = '' if opacity == 1.0 else f' opacity="{opacity}"'
    c = TRAY_CANVAS / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {TRAY_CANVAS} {TRAY_CANVAS}"'
        f' width="{TRAY_CANVAS}" height="{TRAY_CANVAS}" role="img" aria-label="RedLog">\n'
        f'  <title>RedLog</title>\n'
        f'  <g{o}>\n'
        f'    <circle cx="{c}" cy="{c}" r="{TRAY_RING_R}" fill="none"'
        f' stroke="{colour}" stroke-width="{TRAY_RING_W}"/>\n'
        f'    <circle cx="{c}" cy="{c}" r="{TRAY_DOT_R}" fill="{colour}"/>\n'
        f'  </g>\n'
        f'</svg>\n'
    )


class Writer:
    """Collects writes so --check can report staleness instead of mutating."""

    def __init__(self, check_only: bool) -> None:
        self.check_only = check_only
        self.stale: list[str] = []
        self.written: list[str] = []

    def put(self, path: Path, data: bytes) -> None:
        rel = path.relative_to(ROOT).as_posix()
        if path.exists() and path.read_bytes() == data:
            return
        if self.check_only:
            self.stale.append(rel)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.written.append(rel)

    def drop(self, path: Path) -> None:
        if not path.exists():
            return
        rel = path.relative_to(ROOT).as_posix()
        if self.check_only:
            self.stale.append(f'{rel} (should not exist)')
            return
        path.unlink()
        self.written.append(f'{rel} (removed)')


def need(tool: str, hint: str) -> str:
    found = shutil.which(tool)
    if not found:
        sys.exit(f'error: {tool} not found on PATH. {hint}')
    return found


def render(svg: bytes, size: int) -> bytes:
    """SVG bytes -> PNG bytes at size x size."""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / 'in.svg'
        out = Path(td) / 'out.png'
        src.write_bytes(svg)
        subprocess.run(
            ['rsvg-convert', '-w', str(size), '-h', str(size), str(src), '-o', str(out)],
            check=True,
        )
        return out.read_bytes()


def master_for(size: int) -> bytes:
    return (MASTER_RING if size >= RING_MIN_PX else MASTER_DOT).read_bytes()


def build_ico(pngs: list[tuple[int, bytes]]) -> bytes:
    """Windows .ico with a PNG payload per size (Vista and later read these).

    electron-builder will happily make an .ico from a single 256px PNG, but it
    downscales, and a downscaled ring is the exact mush RING_MIN_PX exists to
    avoid — Windows shows the 16px variant in the taskbar and Explorer all day.
    So every size is rendered from the right master instead.
    """
    head = struct.pack('<HHH', 0, 1, len(pngs))
    offset = len(head) + 16 * len(pngs)
    entries, payload = b'', b''
    for size, png in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset)
        payload += png
        offset += len(png)
    return head + entries + payload


def build_icns(w: Writer, target: Path) -> None:
    if sys.platform != 'darwin':
        print(f'skip  {target.relative_to(ROOT)} — iconutil is macOS-only, left as-is')
        return
    need('iconutil', 'It ships with macOS; check xcode-select.')
    # Apple's iconset names: the @2x file for size N is the 2N-pixel render.
    pairs = [(16, '16x16'), (32, '16x16@2x'), (32, '32x32'), (64, '32x32@2x'),
             (128, '128x128'), (256, '128x128@2x'), (256, '256x256'),
             (512, '256x256@2x'), (512, '512x512'), (1024, '512x512@2x')]
    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / 'icon.iconset'
        iconset.mkdir()
        for px, name in pairs:
            (iconset / f'icon_{name}.png').write_bytes(render(master_for(px), px))
        out = Path(td) / 'icon.icns'
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(out)], check=True)
        w.put(target, out.read_bytes())


def main() -> int:
    check_only = '--check' in sys.argv[1:]
    need('rsvg-convert', 'Install it with: brew install librsvg')
    for m in (MASTER_RING, MASTER_DOT):
        if not m.exists():
            sys.exit(f'error: missing master {m.relative_to(ROOT)}')

    w = Writer(check_only)
    ring, dot = MASTER_RING.read_bytes(), MASTER_DOT.read_bytes()

    # Vector sources, copied so resources/ and the renderer bundle are each
    # self-contained. A guard test asserts they stay byte-identical to the
    # masters, which is what makes copying safe.
    w.put(RESOURCES / 'icon.svg', ring)
    w.put(RESOURCES / 'icon-small.svg', dot)
    w.put(RENDERER_ASSETS / 'mark.svg', ring)
    w.put(RENDERER_ASSETS / 'mark-small.svg', dot)

    for size in APP_PNG_SIZES:
        w.put(RESOURCES / f'icon-{size}.png', render(master_for(size), size))

    w.put(RESOURCES / 'icon.ico',
          build_ico([(s, render(master_for(s), s)) for s in ICO_SIZES]))

    build_icns(w, RESOURCES / 'icon.icns')

    tray_black = tray_svg('#000000').encode()
    w.put(RESOURCES / 'tray-icon.svg', tray_black)
    for name, svg in [
        # macOS: black plus alpha, marked as a template image so the system
        # tints it for whichever menu bar it lands in.
        ('tray-iconTemplate', tray_black),
        ('tray-icon-paused', tray_svg('#000000', TRAY_PAUSED_OPACITY).encode()),
        # Windows and Linux: setTemplateImage is a macOS-only API and does
        # nothing there, so black would be a black glyph on a black taskbar.
        # These carry the mark's own colour, which reads on a dark taskbar and
        # a light one alike.
        ('tray-icon-idle', tray_svg(MARK_RED).encode()),
        ('tray-icon-idle-dim', tray_svg(MARK_RED, TRAY_PAUSED_OPACITY).encode()),
        # Recording is coloured on every platform — that is the whole point of
        # the state, so it is never handed to the system to re-tint.
        ('tray-icon-rec', tray_svg(MARK_RED).encode()),
    ]:
        w.put(RESOURCES / f'{name}.png', render(svg, TRAY_CANVAS))
        w.put(RESOURCES / f'{name}@2x.png', render(svg, TRAY_CANVAS * 2))

    # The old wordmark SVG and a stray 44px tray render that nothing loads.
    # Section 16: the wordmark is live text everywhere it appears and
    # deliberately has no SVG file.
    w.drop(RESOURCES / 'logo.svg')
    w.drop(RESOURCES / 'tray-icon@2x.png')
    w.drop(RENDERER_ASSETS / 'logo.svg')

    if check_only:
        if w.stale:
            print('stale, re-run tools/make-icons.py:')
            for s in w.stale:
                print(f'  {s}')
            return 1
        print('icons up to date')
        return 0

    if w.written:
        for f in w.written:
            print(f'wrote {f}')
    else:
        print('nothing to do — every icon already matches the masters')

    # src/main/tray.ts carries a base64 copy of the 2x template as its
    # last-resort fallback for when resources/ is missing at runtime. It cannot
    # read a file by definition, so it cannot be generated — print it here so
    # that updating it is a copy-paste and not a redraw.
    import base64
    b64 = base64.b64encode((RESOURCES / 'tray-iconTemplate@2x.png').read_bytes()).decode()
    print(f'\nfallback for src/main/tray.ts (paste as the createFromDataURL argument):')
    print(f'  data:image/png;base64,{b64}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
