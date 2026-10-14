#!/usr/bin/env python3
"""Render SelfDev's launcher icons from the Android adaptive-icon vectors.

The Android app draws its icon as two vector drawables:

  res/drawable/ic_launcher_background.xml   flat #0F172A square, 108x108
  res/drawable/ic_launcher_foreground.xml  the badge group, scaled 0.65 about
                                           the centre so it stays inside the
                                           adaptive-icon safe zone

Those two files are the single source of truth for the mark, so the desktop
rasters are rendered from the same geometry rather than drawn again by hand.
Run from the repo root:

    python3 scripts/make-icons.py

Requires Pillow. The generated PNGs are committed; this only needs re-running
when the Android vectors change.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets"

SS = 8  # supersampling factor, downscaled at the end for clean edges
VIEWPORT = 108

BACKGROUND = (0x0F, 0x17, 0x2A)
GRADIENT = [(0.00, (0x4F, 0x46, 0xE5)), (0.50, (0x25, 0x63, 0xEB)), (1.00, (0x06, 0xB6, 0xD4))]
BRACKET = (0xFF, 0xFF, 0xFF)
SPARKLE = (0xF8, 0xFA, 0xFC)
DOT = (0xA5, 0xF3, 0xFC)

# Foreground badge geometry, in the 108x108 viewport before the 0.65 scale.
BADGE = (4.0, 4.0, 104.0, 104.0)
BADGE_RADIUS = 24.0
BRACKET_STROKE = 5.0
LEFT_BRACKET = [((30, 54), (40, 42)), ((30, 54), (40, 66))]
RIGHT_BRACKET = [((78, 54), (68, 42)), ((78, 54), (68, 66))]
SPARKLE_POINTS = [(54, 32), (56.2, 43.5), (67, 46), (56.2, 48.5), (54, 60), (51.8, 48.5), (41, 46), (51.8, 43.5)]
DOT_CENTER = (54.0, 72.0)
DOT_RADIUS = 3.5

FOREGROUND_SCALE = 0.65
FOREGROUND_PIVOT = (54.0, 54.0)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def gradient_color(t: float) -> tuple[int, int, int, int]:
    t = min(1.0, max(0.0, t))
    for (t0, c0), (t1, c1) in zip(GRADIENT, GRADIENT[1:]):
        if t <= t1:
            span = (t1 - t0) or 1.0
            local = (t - t0) / span
            return (
                int(round(lerp(c0[0], c1[0], local))),
                int(round(lerp(c0[1], c1[1], local))),
                int(round(lerp(c0[2], c1[2], local))),
                255,
            )
    return (*GRADIENT[-1][1], 255)


def build_gradient(size: int, group_scale: float) -> Image.Image:
    """Linear gradient along the badge diagonal, start (4,4) -> end (104,104).

    The stops live in the badge group's own coordinates, so the gradient is
    sampled per foreground-group pixel rather than per canvas pixel.
    """
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    per_viewport = size / VIEWPORT
    for y in range(size):
        for x in range(size):
            lx = FOREGROUND_PIVOT[0] + (x / per_viewport - FOREGROUND_PIVOT[0]) / group_scale
            ly = FOREGROUND_PIVOT[1] + (y / per_viewport - FOREGROUND_PIVOT[1]) / group_scale
            px[x, y] = gradient_color(((lx - 4) + (ly - 4)) / 200.0)
    return grad


def draw_round_capped_line(draw: ImageDraw.ImageDraw, a, b, color, width: float) -> None:
    """A stroked segment with round caps and joins, as the vector declares."""
    ax, ay = a
    bx, by = b
    half = width / 2.0
    draw.line([(ax, ay), (bx, by)], fill=color, width=int(round(width)))
    for x, y in ((ax, ay), (bx, by)):
        draw.ellipse([x - half, y - half, x + half, y + half], fill=color)


def render(size: int) -> Image.Image:
    big = size * SS
    canvas = Image.new("RGBA", (big, big), (*BACKGROUND, 255))

    # Foreground group, scaled about the pivot the way <group> does.
    def to_px(x: float, y: float) -> tuple[float, float]:
        k = big / VIEWPORT
        sx = FOREGROUND_PIVOT[0] + FOREGROUND_SCALE * (x - FOREGROUND_PIVOT[0])
        sy = FOREGROUND_PIVOT[1] + FOREGROUND_SCALE * (y - FOREGROUND_PIVOT[1])
        return sx * k, sy * k

    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    x0, y0 = to_px(*BADGE[:2])
    x1, y1 = to_px(BADGE[2], BADGE[3])
    radius = BADGE_RADIUS * FOREGROUND_SCALE * (big / VIEWPORT)

    # Gradient fill clipped to the badge silhouette.
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=255)
    layer.paste(build_gradient(big, FOREGROUND_SCALE), (0, 0), mask)

    for segment in LEFT_BRACKET + RIGHT_BRACKET:
        draw_round_capped_line(
            d, to_px(*segment[0]), to_px(*segment[1]), (*BRACKET, 255), BRACKET_STROKE * FOREGROUND_SCALE * (big / VIEWPORT)
        )

    d.polygon([to_px(x, y) for x, y in SPARKLE_POINTS], fill=(*SPARKLE, 255))

    dcx, dcy = to_px(*DOT_CENTER)
    dr = DOT_RADIUS * FOREGROUND_SCALE * (big / VIEWPORT)
    d.ellipse([dcx - dr, dcy - dr, dcx + dr, dcy + dr], fill=(*DOT, 255))

    canvas = Image.alpha_composite(canvas, layer)
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (512, 256):
        path = OUT_DIR / f"icon-{size}.png" if size != 512 else OUT_DIR / "icon.png"
        render(size).save(path, "PNG")
        print(f"[icons] wrote {path.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    # `math` is imported for readers extending the gradient helper; keep linters quiet.
    main()