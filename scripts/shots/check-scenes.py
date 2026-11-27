#!/usr/bin/env python3
"""Content checks for the raw scene captures, plus a labeled contact sheet of every site image.

Usage: python3 scripts/shots/check-scenes.py <raw-dir> <shots-dir> <contact-sheet.png>

Checks, per scene under <raw-dir>/raw/<label>/ (written by capture.sh):
  every scene  exactly two foot windows in tree.json (both demo terminals are up).
  every scene  the bar strip (gap between output and visible workspace, from Sway IPC) has the height
               that the waybar config this scene ran with declares (waybar-config.jsonc, "height").
  mako-*       the notification crop (changed pixels, pre.png vs desktop.png) is non-empty and covers
               less than 25% of the screen.
  fuzzel-*     the launcher crop (changed pixels, desktop.png vs launcher.png) is non-empty and is not the
               full screen.
The contact sheet puts every image from <shots-dir> in one PNG with its file name under it.
Exit status 1 if any check fails. Problems are printed one per line.
"""
import glob
import json
import os
import re
import sys

from PIL import Image, ImageChops, ImageDraw

DIFF_THRESHOLD = 24  # same threshold as crop.py: a pixel changed when a channel moved by more than this
MAX_NOTIFY_AREA = 0.25  # the mako crop must stay under a quarter of the screen

raw_root, shots_dir, sheet_path = sys.argv[1], sys.argv[2], sys.argv[3]
problems = []
checked = []


def walk(node):
    yield node
    for key in ("nodes", "floating_nodes"):
        for child in node.get(key, []):
            yield from walk(child)


def changed_box(before, after):
    diff = ImageChops.difference(before, after).convert("L").point(lambda v: 255 if v > DIFF_THRESHOLD else 0)
    return diff.getbbox()


def bar_height(raw):
    """Height of the bar strip from Sway IPC, the same way crop.py finds it."""
    with open(os.path.join(raw, "outputs.json")) as f:
        outputs = json.load(f)
    with open(os.path.join(raw, "workspaces.json")) as f:
        workspaces = json.load(f)
    output = next((o for o in outputs if o.get("active")), None)
    if output is None:
        return None
    ws = next((w for w in workspaces if w.get("visible") and w.get("output") == output["name"]), None)
    if ws is None:
        return None
    out_rect, ws_rect = output["rect"], ws["rect"]
    top = ws_rect["y"] - out_rect["y"]
    bottom = (out_rect["y"] + out_rect["height"]) - (ws_rect["y"] + ws_rect["height"])
    return max(top, bottom)


def configured_height(raw):
    with open(os.path.join(raw, "waybar-config.jsonc")) as f:
        match = re.search(r'"height"\s*:\s*(\d+)', f.read())
    return int(match.group(1)) if match else None


for raw in sorted(glob.glob(os.path.join(raw_root, "raw", "*"))):
    label = os.path.basename(raw)
    with open(os.path.join(raw, "target")) as f:
        target = f.read().split()
    desktop = Image.open(os.path.join(raw, "desktop.png")).convert("RGB")
    screen_area = desktop.width * desktop.height
    checked.append(label)

    # Two foot windows: the demo runs two terminals in every scene.
    with open(os.path.join(raw, "tree.json")) as f:
        tree = json.load(f)
    foot = [n for n in walk(tree) if n.get("app_id") == "foot" and n.get("type") == "con"]
    if len(foot) != 2:
        problems.append(f"{label}: expected exactly 2 foot windows in get_tree, found {len(foot)}")

    # Bar strip height matches the waybar config this scene ran with.
    want = configured_height(raw)
    got = bar_height(raw)
    if want is None:
        problems.append(f"{label}: no height in waybar-config.jsonc")
    elif got != want:
        problems.append(f"{label}: bar strip is {got} px, waybar config declares {want} px")

    if target[0] == "variant" and target[1] == "mako":
        pre = Image.open(os.path.join(raw, "pre.png")).convert("RGB")
        box = changed_box(pre, desktop)
        if box is None:
            problems.append(f"{label}: mako crop is empty (no notification pixels)")
        else:
            area = (box[2] - box[0]) * (box[3] - box[1])
            if area >= MAX_NOTIFY_AREA * screen_area:
                problems.append(f"{label}: mako crop covers {100 * area / screen_area:.0f}% of the screen (limit 25%)")

    if target[0] == "variant" and target[1] == "fuzzel":
        launcher = Image.open(os.path.join(raw, "launcher.png")).convert("RGB")
        box = changed_box(desktop, launcher)
        if box is None:
            problems.append(f"{label}: fuzzel crop is empty (launcher did not appear)")
        elif (box[2] - box[0]) * (box[3] - box[1]) >= screen_area:
            problems.append(f"{label}: fuzzel crop is the whole screen")

# Contact sheet: every site image, in name order, each with its file name under it.
images = sorted(glob.glob(os.path.join(shots_dir, "*.webp")))
if not images:
    problems.append(f"no images in {shots_dir} for the contact sheet")
else:
    cell_w, thumb_h, label_h, cols, gap = 320, 200, 22, 4, 12
    cells = []
    for path in images:
        im = Image.open(path).convert("RGB")
        scale = min(cell_w / im.width, thumb_h / im.height)
        cells.append((os.path.basename(path), im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))))))
    rows = (len(cells) + cols - 1) // cols
    cell_h = thumb_h + label_h
    sheet = Image.new("RGB", (cols * (cell_w + gap) + gap, rows * (cell_h + gap) + gap), (40, 40, 40))
    draw = ImageDraw.Draw(sheet)
    for i, (name, thumb) in enumerate(cells):
        x = gap + (i % cols) * (cell_w + gap)
        y = gap + (i // cols) * (cell_h + gap)
        sheet.paste(thumb, (x + (cell_w - thumb.width) // 2, y + (thumb_h - thumb.height) // 2))
        draw.text((x, y + thumb_h + 4), name, fill=(240, 240, 240))
    sheet.save(sheet_path, "PNG")
    print(f"contact sheet: {len(cells)} image(s) -> {sheet_path}")

print(f"scene checks: {len(checked)} scene(s) checked")
if problems:
    for p in problems:
        print(f"  {p}", file=sys.stderr)
    print(f"scene checks: {len(problems)} problem(s)", file=sys.stderr)
    sys.exit(1)
print("scene checks: all passed")
