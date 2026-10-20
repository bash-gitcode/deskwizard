#!/usr/bin/env python3
"""Checks that each swaybg capture is its own variant's wallpaper.

For every <raw-dir>/raw/swaybg-<variant>/wallpaper.png, both the capture and every source wallpaper
(catalog/tools/swaybg/variants/<NN>/wallpaper.png) are box-downscaled to 32x18 RGB. Then:
  own   mean absolute difference to its own source must be <= OWN_MAX (0-255 scale)
  other mean absolute difference to every other source must be >= OTHER_MIN
A capture of the terminal background (the bug this guards against) is about 64 from its own source and fails.

Thresholds:
  OWN_MAX 10: the capture is the same size as the source, so the only difference is the downscale and PNG
    round trip. Measured: 0 for a correct wallpaper.
  OTHER_MIN 20: the closest pair of sources is 24.0 apart at this size (mono vs ridge, measured), so 20 leaves
    a small margin for the capture while still separating every pair.
Usage: python3 scripts/shots/check-wallpapers.py <scene-raw-dir> [sources-dir]
Exit status 1 if a capture or source is missing or a threshold is not met.
"""
import glob
import os
import sys

from PIL import Image

OWN_MAX = 10
OTHER_MIN = 20
SMALL = (32, 18)

raw_root = sys.argv[1]
sources_dir = sys.argv[2] if len(sys.argv) > 2 else "catalog/tools/swaybg/variants"
problems = []


def small(path):
    return list(Image.open(path).convert("RGB").resize(SMALL, Image.BOX).tobytes())


def mad(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


sources = {}
for path in sorted(glob.glob(os.path.join(sources_dir, "*", "wallpaper.png"))):
    sources[os.path.basename(os.path.dirname(path))] = small(path)
if len(sources) < 2:
    print(f"check-wallpapers: need at least two source wallpapers under {sources_dir}", file=sys.stderr)
    sys.exit(1)

captures = sorted(glob.glob(os.path.join(raw_root, "raw", "swaybg-*")))
if not captures:
    print(f"check-wallpapers: no swaybg captures under {raw_root}/raw", file=sys.stderr)
    sys.exit(1)

for cap_dir in captures:
    variant = os.path.basename(cap_dir)[len("swaybg-"):]
    cap_path = os.path.join(cap_dir, "wallpaper.png")
    if not os.path.exists(cap_path):
        problems.append(f"{variant}: no wallpaper.png capture")
        continue
    if variant not in sources:
        problems.append(f"{variant}: no source wallpaper for this variant")
        continue
    cap = small(cap_path)
    own = mad(cap, sources[variant])
    print(f"swaybg {variant}: own source {own:.2f}")
    if own > OWN_MAX:
        problems.append(f"{variant}: capture differs from its own source by {own:.2f} (max {OWN_MAX})")
    for other, src in sources.items():
        if other == variant:
            continue
        d = mad(cap, src)
        print(f"swaybg {variant}: vs variant {other} {d:.2f}")
        if d < OTHER_MIN:
            problems.append(f"{variant}: capture is only {d:.2f} from variant {other}'s wallpaper (min {OTHER_MIN})")

if problems:
    print(f"check-wallpapers: {len(problems)} problem(s):", file=sys.stderr)
    for p in problems:
        print(f"  {p}", file=sys.stderr)
    sys.exit(1)
print("check-wallpapers: every swaybg capture matches its own wallpaper")
