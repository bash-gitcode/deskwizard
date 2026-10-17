#!/usr/bin/env bash
# Forces the Nerd Font download to fail and checks that the installer falls back to
# fonts-font-awesome. The function is copied out of the generated installer (not re-typed),
# and only curl and sudo are replaced, so the test exercises the shipped code.
# Requires site/public/v1/install.sh (run `npm run build` first). Exit 0 = pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$ROOT/site/public/v1/install.sh"
[ -s "$INSTALLER" ] || { echo "test-font-fallback: $INSTALLER missing. Run npm run build first." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull install_nerd_font (from its first line to the closing brace at column 0).
sed -n '/^install_nerd_font() {$/,/^}$/p' "$INSTALLER" > "$WORK/fn.sh"
[ -s "$WORK/fn.sh" ] || { echo "test-font-fallback: install_nerd_font not found in $INSTALLER" >&2; exit 1; }

# The variables the function reads, taken from the generated installer itself.
for var in NERD_FONT_VERSION NERD_FONT_ARCHIVE NERD_FONT_SHA256 NERD_FONT_DEST NERD_FONT_FALLBACK_PKG FONT_NAME; do
  value="$(sed -n "s/^${var}=\"\(.*\)\"$/\1/p" "$INSTALLER" | head -n 1)"
  [ -n "$value" ] || { echo "test-font-fallback: $var not set in installer" >&2; exit 1; }
  printf -v "$var" '%s' "$value"
done
DRY_RUN=false

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# Fail every download, as if github.com were unreachable.
curl() { return 6; }
# Record sudo calls instead of running them.
sudo() { printf 'sudo %s\n' "$*" >> "$WORK/sudo.log"; }
fc-cache() { :; }

# shellcheck source=/dev/null
. "$WORK/fn.sh"
install_nerd_font > "$WORK/out.log" 2> "$WORK/err.log"

fail=0
grep -q "fonts-font-awesome" "$WORK/err.log" || { echo "FAIL: no warning naming fonts-font-awesome" >&2; fail=1; }
grep -qx "sudo apt-get install -y fonts-font-awesome" "$WORK/sudo.log" 2>/dev/null \
  || { echo "FAIL: fonts-font-awesome was not installed with apt" >&2; fail=1; }
if [ "$fail" -ne 0 ]; then
  echo "--- stderr ---" >&2; cat "$WORK/err.log" >&2
  exit 1
fi
echo "PASS: download failure falls back to fonts-font-awesome"
