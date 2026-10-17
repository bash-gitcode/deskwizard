#!/usr/bin/env bash
# Conffile check (CI, debian:trixie, normal user with passwordless sudo).
# A pre-existing /etc/greetd/config.toml must not make the greetd install stop at dpkg's conffile
# prompt. The test runs the greetd build with stdin closed (</dev/null) under a timeout, so a
# prompt or a hang fails the job instead of stalling it.
# Asserts: the install exits 0 in time, the backup holds the original content, the final file is ours.
# Outputs go to $OUT (default: ./conffile-out). Usage: bash scripts/conffile-check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/conffile-out}"
V1="$ROOT/site/public/v1"
SUMMARY="$OUT/summary.md"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ "$(id -u)" -ne 0 ] || { echo "conffile-check: run as a normal user (the installer refuses root)" >&2; exit 2; }
[ -s "$V1/install.sh" ] || { echo "conffile-check: run npm run build first" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT"
fail=0
note() { echo "$1" | tee -a "$SUMMARY"; }
{ echo "## Conffile check (debian:trixie, greetd install over an existing config.toml)"; echo; } > "$SUMMARY"

ORIGINAL='# ORIGINAL-CONFFILE-MARKER: written by the user before install'

# Seed the file BEFORE greetd is installed, so dpkg meets an existing conffile.
sudo mkdir -p /etc/greetd
printf '%s\n' "$ORIGINAL" | sudo tee /etc/greetd/config.toml > /dev/null
if dpkg -s greetd >/dev/null 2>&1; then
  note "- greetd not yet installed before the seed: FAIL (the test would not reproduce the conffile case)"; fail=1
else
  note "- greetd not yet installed before the seed: PASS"
fi

CODE="$(node "$ROOT/scripts/ci-helpers.mjs" code greetd)" || { echo "conffile-check: could not build the greetd code" >&2; exit 1; }
DESKWIZARD_TEST_MODE=1 DESKWIZARD_TEST_BASE_URL="file://$V1" \
  timeout 600 bash "$V1/install.sh" --build "$CODE" > "$OUT/install-greetd.log" 2>&1 < /dev/null
rc=$?
if [ "$rc" -eq 124 ]; then
  note "- greetd install finished without hanging (timeout after 600s): FAIL"; fail=1
elif [ "$rc" -eq 0 ]; then
  note "- greetd install exits 0 with stdin closed: PASS"
else
  note "- greetd install exits 0 with stdin closed (exit $rc): FAIL"; fail=1
fi

# sudo cannot read a process-substitution pipe, so the expected content goes to a real file first.
printf '%s\n' "$ORIGINAL" > "$WORK/original.toml"
LATEST="$(find "$HOME/.config-backup" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
if [ -n "$LATEST" ] && sudo cmp -s "$LATEST/system/etc/greetd/config.toml" "$WORK/original.toml"; then
  note "- backup holds the original config.toml ($LATEST): PASS"
else
  note "- backup holds the original config.toml: FAIL"; fail=1
fi

if sudo grep -q 'Written by deskwizard' /etc/greetd/config.toml && ! sudo grep -q 'ORIGINAL-CONFFILE-MARKER' /etc/greetd/config.toml; then
  note "- final /etc/greetd/config.toml is the deskwizard file: PASS"
else
  note "- final /etc/greetd/config.toml is the deskwizard file: FAIL"; fail=1
fi

if [ "$fail" -eq 0 ]; then note "**conffile check passed.**"; else note "**conffile check failed.** See install-greetd.log."; fi
exit "$fail"
