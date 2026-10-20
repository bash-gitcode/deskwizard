#!/usr/bin/env python3
"""Fails if two scene images are byte-identical, unless the allowlist marks that pair as intentional.

Applies to every pair in the directory: two variants of one tool, two bases, or a base and a tool image.
Identical bytes mean identical pixels here, so a duplicate means a scene did not really change
(for example, a capture that showed the same background as another variant).

The allowlist is scripts/shots/duplicates.json: {"allowed": [{"files": ["a.webp", "b.webp"], "reason": "..."}]}.
An entry matches a pair when its two file names (in any order) are both listed in "files" and the pair is duplicate.
Usage: python3 scripts/shots/check-duplicates.py <image-dir> [allowlist.json]
Exit status 1 if an unlisted duplicate pair exists, or if the allowlist itself is malformed.
"""
import hashlib
import itertools
import json
import os
import sys

DEFAULT_ALLOWLIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "duplicates.json")


def load_allowlist(path):
    if not os.path.exists(path):
        return set()
    with open(path) as f:
        data = json.load(f)
    pairs = set()
    for entry in data.get("allowed", []):
        files = entry.get("files", [])
        if len(files) != 2 or not entry.get("reason"):
            raise SystemExit(f"check-duplicates: allowlist entry needs exactly two files and a reason: {entry}")
        pairs.add(frozenset(files))
    return pairs


def main():
    image_dir = sys.argv[1]
    allowlist = load_allowlist(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_ALLOWLIST)
    images = sorted(f for f in os.listdir(image_dir) if f.endswith(".webp"))
    if len(images) < 2:
        print(f"check-duplicates: fewer than two images in {image_dir}", file=sys.stderr)
        return 1

    digests = {}
    for name in images:
        with open(os.path.join(image_dir, name), "rb") as f:
            digests[name] = hashlib.sha256(f.read()).hexdigest()

    problems = []
    allowed_used = set()
    for a, b in itertools.combinations(images, 2):
        if digests[a] != digests[b]:
            continue
        pair = frozenset((a, b))
        if pair in allowlist:
            allowed_used.add(pair)
            print(f"check-duplicates: allowed duplicate: {a} == {b}")
        else:
            problems.append(f"{a} and {b} are byte-identical (sha256 {digests[a][:16]})")

    unused = allowlist - allowed_used
    for pair in unused:
        print(f"check-duplicates: note: allowlist entry not used by any duplicate: {sorted(pair)}")

    if problems:
        print(f"check-duplicates: {len(problems)} unlisted duplicate pair(s):", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(f"check-duplicates: {len(images)} images, no unlisted duplicates")
    return 0


if __name__ == "__main__":
    sys.exit(main())
