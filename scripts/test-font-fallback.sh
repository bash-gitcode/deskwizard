#!/usr/bin/env bash
# Forces the Nerd Font download to fail and checks that the real installer reports the fallback to
# fonts-font-awesome. It runs site/public/v1/install.sh in --dry-run mode with the test-only hooks
# (DESKWIZARD_TEST_MODE=1 is required; a normal run ignores them):
#   DESKWIZARD_TEST_BASE_URL  file:// copy of the built v1/ folder, so no server is needed
#   DESKWIZARD_TEST_FONT_URL  a file that does not exist, so the font download fails
# HOME is a temporary directory, so nothing in the real home is touched.
# Requires `npm run build` first. Exit 0 = pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V1="$ROOT/site/public/v1"
[ -s "$V1/install.sh" ] || { echo "test-font-fallback: $V1/install.sh missing. Run npm run build first." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home"

# The build code for the default build, made with the same generator the wizard uses.
CODE="$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { buildCode } from '$ROOT/site/src/generator.js';
const catalog = JSON.parse(readFileSync('$ROOT/site/public/catalog.json', 'utf8'));
process.stdout.write(buildCode({
  distro: 'debian13', display: 'wayland', font: 'jetbrains-mono', palette: 'midnight',
  start: 'manual', extras: [], choices: { sway: { variant: null }, waybar: { variant: 'minimal' } },
}, catalog.catalog_version));
")"
[ -n "$CODE" ] || { echo "test-font-fallback: could not build the test code" >&2; exit 1; }

status=0
HOME="$WORK/home" \
DESKWIZARD_TEST_MODE=1 \
DESKWIZARD_TEST_BASE_URL="file://$V1" \
DESKWIZARD_TEST_FONT_URL="file://$WORK/does-not-exist.tar.xz" \
  bash "$V1/install.sh" --build "$CODE" --dry-run > "$WORK/out.log" 2>&1 || status=$?

if [ "$status" -ne 0 ]; then
  echo "FAIL: installer dry-run exited $status" >&2
  cat "$WORK/out.log" >&2
  exit 1
fi

fail=0
grep -q "could not reach" "$WORK/out.log" || { echo "FAIL: dry-run did not report the unreachable font" >&2; fail=1; }
grep -q "would fall back to fonts-font-awesome" "$WORK/out.log" || { echo "FAIL: dry-run did not name fonts-font-awesome as the fallback" >&2; fail=1; }
if [ "$fail" -ne 0 ]; then
  cat "$WORK/out.log" >&2
  exit 1
fi
echo "PASS: unreachable font download falls back to fonts-font-awesome (dry-run)"
