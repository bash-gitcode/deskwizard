#!/usr/bin/env python3
"""Turns the raw scene captures (<raw-dir>/raw/<label>/, written by scripts/shots/capture.sh) into WebP site images.

Crop method per tool (no hard-coded pixels):
  foot     the rectangle of the leftmost foot window, from Sway's get_tree (padded)
  waybar   the bar strip: the gap between the output rectangle and the visible workspace rectangle, from
           get_outputs and get_workspaces. Fails if Sway reports no gap.
  mako     bounding box of the pixels that changed when the notifications appeared (pre.png vs desktop.png)
  fuzzel   bounding box of the pixels that changed when the launcher opened (desktop.png vs launcher.png)
  swaybg   the full frame (desktop.png)
A base scene is saved as its full frame (desktop.png).

Images are named base-<id>.webp and <tool>-<variant>.webp in <out-dir>. Each image must be under 200 KB; the
WebP quality is lowered (80 down to 50) until it is under 150 KB. Sizes are printed and written to <out-dir>/sizes.md.
Usage: python3 scripts/shots/crop.py <raw-dir> <out-dir>
Exit status 1 if any image could not be produced or is over the size limit; the problems are printed.
"""
import glob
import json
import os
import sys

from PIL import Image, ImageChops

PAD = 12
MAX_BYTES = 200 * 1024
TARGET_BYTES = 150 * 1024
QUALITIES = (80, 70, 60, 50)
DIFF_THRESHOLD = 24  # a pixel counts as changed when any channel moves by more than this (ignores faint noise)

raw_root, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)
problems = []
rows = []


def save(img, name, label):
    path = os.path.join(out_dir, name)
    size = 0
    quality = QUALITIES[0]
    for quality in QUALITIES:
        img.save(path, "WEBP", quality=quality, method=6)
        size = os.path.getsize(path)
        if size <= TARGET_BYTES:
            break
    if size > MAX_BYTES:
        problems.append(f"{label}: {name} is {size // 1024} KB, over the {MAX_BYTES // 1024} KB limit")
    rows.append((name, img.width, img.height, quality, size))


def load_json(path):
    with open(path) as f:
        return json.load(f)


def walk(node):
    yield node
    for key in ("nodes", "floating_nodes"):
        for child in node.get(key, []):
            yield from walk(child)


def rect_box(rect):
    return (rect["x"], rect["y"], rect["x"] + rect["width"], rect["y"] + rect["height"])


def pad_box(box, img):
    x1, y1, x2, y2 = box
    return (max(0, x1 - PAD), max(0, y1 - PAD), min(img.width, x2 + PAD), min(img.height, y2 + PAD))


def changed_box(before, after):
    diff = ImageChops.difference(before, after).convert("L").point(lambda v: 255 if v > DIFF_THRESHOLD else 0)
    return diff.getbbox()


def check_box(box, img, label, what):
    if box is None:
        problems.append(f"{label}: {what}: no changed pixels found (the surface did not appear)")
        return None
    x1, y1, x2, y2 = box
    if (x2 - x1) * (y2 - y1) >= 0.95 * img.width * img.height:
        problems.append(f"{label}: {what}: the box covers the whole screen")
        return None
    return box


def crop_foot(label, raw, desktop, tree):
    windows = [n for n in walk(tree) if n.get("app_id") == "foot" and n.get("type") == "con"]
    if not windows:
        problems.append(f"{label}: foot: no foot window in get_tree")
        return None
    leftmost = min(windows, key=lambda n: n["rect"]["x"])
    return check_box(rect_box(leftmost["rect"]), desktop, label, "foot window")


def crop_waybar(label, raw, desktop):
    outputs = load_json(os.path.join(raw, "outputs.json"))
    workspaces = load_json(os.path.join(raw, "workspaces.json"))
    output = next((o for o in outputs if o.get("active")), None)
    if output is None:
        problems.append(f"{label}: waybar: no active output in get_outputs")
        return None
    ws = next((w for w in workspaces if w.get("visible") and w.get("output") == output["name"]), None)
    if ws is None:
        problems.append(f"{label}: waybar: no visible workspace on {output['name']} in get_workspaces")
        return None
    out_rect, ws_rect = output["rect"], ws["rect"]
    top = ws_rect["y"] - out_rect["y"]
    bottom = (out_rect["y"] + out_rect["height"]) - (ws_rect["y"] + ws_rect["height"])
    if top <= 0 and bottom <= 0:
        problems.append(f"{label}: waybar: get_workspaces reports no bar strip (workspace rect equals output rect)")
        return None
    if top >= bottom:
        box = (out_rect["x"], out_rect["y"], out_rect["x"] + out_rect["width"], out_rect["y"] + top)
    else:
        box = (out_rect["x"], out_rect["y"] + out_rect["height"] - bottom, out_rect["x"] + out_rect["width"], out_rect["y"] + out_rect["height"])
    return check_box(box, desktop, label, "waybar strip")


labels = sorted(glob.glob(os.path.join(raw_root, "raw", "*")))
if not labels:
    print(f"crop: no captures under {raw_root}/raw", file=sys.stderr)
    sys.exit(1)

for raw in labels:
    label = os.path.basename(raw)
    with open(os.path.join(raw, "target")) as f:
        target = f.read().split()
    desktop_path = os.path.join(raw, "desktop.png")
    if not os.path.exists(desktop_path):
        problems.append(f"{label}: no desktop capture")
        continue
    desktop = Image.open(desktop_path).convert("RGB")

    if target[0] == "base":
        save(desktop, f"base-{target[1]}.webp", label)
        continue

    tool, variant = target[1], target[2]
    name = f"{tool}-{variant}.webp"
    box = None
    if tool == "swaybg":
        # The wallpaper alone, captured before the foot windows opened (see capture.sh).
        wallpaper_path = os.path.join(raw, "wallpaper.png")
        if not os.path.exists(wallpaper_path):
            problems.append(f"{label}: swaybg: no wallpaper.png capture")
            continue
        save(Image.open(wallpaper_path).convert("RGB"), name, label)
        continue
    if tool == "foot":
        box = crop_foot(label, raw, desktop, load_json(os.path.join(raw, "tree.json")))
    elif tool == "waybar":
        box = crop_waybar(label, raw, desktop)
    elif tool == "mako":
        pre = Image.open(os.path.join(raw, "pre.png")).convert("RGB")
        box = check_box(changed_box(pre, desktop), desktop, label, "mako notifications")
    elif tool == "fuzzel":
        launcher = Image.open(os.path.join(raw, "launcher.png")).convert("RGB")
        box = check_box(changed_box(desktop, launcher), desktop, label, "fuzzel launcher")
        if box is not None:
            desktop = launcher
    else:
        problems.append(f"{label}: no crop method for tool '{tool}'")
        continue
    if box is None:
        continue
    save(desktop.crop(pad_box(box, desktop) if tool != "waybar" else box), name, label)

lines = ["### Scene images", "", "| Image | Size | Quality | KB |", "|---|---|---|---|"]
for name, w, h, quality, size in rows:
    lines.append(f"| {name} | {w}x{h} | {quality} | {size / 1024:.1f} |")
table = "\n".join(lines) + "\n"
print(table)
# The job summary is written by a later step: this runs as a non-root user that cannot write to it.
with open(os.path.join(out_dir, "sizes.md"), "w") as f:
    f.write(table)

if problems:
    print(f"crop: {len(problems)} problem(s):", file=sys.stderr)
    for p in problems:
        print(f"  {p}", file=sys.stderr)
    sys.exit(1)
print(f"crop: {len(rows)} image(s) written to {out_dir}")
