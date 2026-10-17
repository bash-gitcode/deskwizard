#!/usr/bin/env bash
# Waybar variant smoke test (CI Job B, and local via a debian:trixie container).
#
# For every variant in catalog/tools/waybar/variants/NN:
#   1. copy its config.jsonc and style.css into ~/.config/waybar
#   2. start waybar on a headless Sway session (1920x1080)
#   3. wait 5 seconds and assert waybar is still running
#   4. FAIL the variant if its stderr has a line with "error" or "failed"
#   5. list lines with "warn" separately (they do not fail the run)
#   6. save a screenshot with grim
# Outputs go to $OUT (default: ./smoke-out): <variant>.png, <variant>.log, sway.log, summary.txt.
#
# Needs: sway waybar grim fontconfig and the pinned Nerd Font installed, run as a non-root user.
# Usage: bash scripts/smoke-waybar.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANTS="$ROOT/catalog/tools/waybar/variants"
OUT="${OUT:-$ROOT/smoke-out}"
RUN_SECONDS="${RUN_SECONDS:-5}"
CFG_DIR="$HOME/.config/waybar"

[ "$(id -u)" -ne 0 ] || { echo "smoke-waybar: run as a normal user (sway refuses root sessions in CI too)" >&2; exit 2; }
for cmd in sway swaymsg waybar grim; do
  command -v "$cmd" >/dev/null || { echo "smoke-waybar: '$cmd' is not installed" >&2; exit 2; }
done

rm -rf "$OUT"
mkdir -p "$OUT" "$CFG_DIR"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$(mktemp -d)}"
chmod 700 "$XDG_RUNTIME_DIR"

# ---- headless Sway ----------------------------------------------------------
SWAY_CFG="$OUT/sway-config"
cat > "$SWAY_CFG" <<'EOF'
output HEADLESS-1 mode 1920x1080
EOF

WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman LIBSEAT_BACKEND=noop \
  sway -c "$SWAY_CFG" > "$OUT/sway.log" 2>&1 &
SWAY_PID=$!

# Wait up to 30 s for the IPC socket to answer.
ready=false
for _ in $(seq 1 30); do
  if swaymsg -t get_outputs >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$SWAY_PID" 2>/dev/null || break
  sleep 1
done
if [ "$ready" != true ]; then
  echo "smoke-waybar: sway did not start. See $OUT/sway.log" >&2
  tail -n 40 "$OUT/sway.log" >&2
  exit 1
fi

cleanup() {
  pkill -P $$ waybar 2>/dev/null || true
  kill "$SWAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ---- variants ---------------------------------------------------------------
failed=0
summary="$OUT/summary.txt"
: > "$summary"

for vdir in "$VARIANTS"/*/; do
  num="$(basename "$vdir")"
  name="$(awk -F': *' '/^id:/ {print $2; exit}' "$vdir/meta.yaml" 2>/dev/null | tr -d '"')"
  name="${name:-variant-$num}"
  label="$num-$name"
  log="$OUT/$label.log"

  cp "$vdir/config.jsonc" "$CFG_DIR/config.jsonc"
  cp "$vdir/style.css" "$CFG_DIR/style.css"

  waybar -c "$CFG_DIR/config.jsonc" -s "$CFG_DIR/style.css" > "$log" 2>&1 &
  wb_pid=$!
  sleep "$RUN_SECONDS"

  status="PASS"
  reasons=""
  if ! kill -0 "$wb_pid" 2>/dev/null; then
    status="FAIL"
    reasons="waybar exited within ${RUN_SECONDS}s"
  fi
  if grep -iE 'error|failed' "$log" > "$OUT/$label.errors" 2>/dev/null && [ -s "$OUT/$label.errors" ]; then
    status="FAIL"
    reasons="${reasons:+$reasons; }error lines in log"
  fi

  if [ "$status" = PASS ]; then
    grim "$OUT/$label.png" || { status="FAIL"; reasons="${reasons:+$reasons; }grim could not take a screenshot"; }
  fi

  warnings="$(grep -ic 'warn' "$log" || true)"
  echo "$label: $status${reasons:+ ($reasons)}; warnings: $warnings" | tee -a "$summary"
  if [ "$warnings" -gt 0 ]; then
    grep -i 'warn' "$log" | sed 's/^/    /' | tee -a "$summary"
  fi

  kill "$wb_pid" 2>/dev/null || true
  wait "$wb_pid" 2>/dev/null || true
  [ "$status" = PASS ] || failed=$((failed + 1))
done

echo "smoke-waybar: $failed variant(s) failed. Outputs in $OUT"
[ "$failed" -eq 0 ]
