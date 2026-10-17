#!/usr/bin/env bash
# Tool smoke test (CI job "tool-smoke", and local via a debian:trixie container).
#
# For every variant of waybar, foot, fuzzel, mako and swaybg:
#   1. stage the files the installer would write (scripts/smoke-stage.mjs) and copy them into $HOME
#   2. start the tool on a headless Sway session (1920x1080, pixman renderer)
#   3. wait RUN_SECONDS (default 5) and assert the tool is still running
#   4. FAIL the variant on any error line in its log, except the ignored lines listed below
#   5. list warning lines and every ignored line in the summary (they do not fail the run)
#   6. save a screenshot with grim
# Outputs go to $OUT (default: ./smoke-out): <tool>-<variant>.png, .log, sway.log, summary.md.
# CI appends summary.md to the job summary in a separate root step.
#
# Needs: sway, grim, the five tools, fontconfig and the pinned Nerd Font, run as a non-root user.
# Usage: bash scripts/smoke-tools.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/smoke-out}"
RUN_SECONDS="${RUN_SECONDS:-5}"
# Error lines: "[error]" (waybar), "err: " (fuzzel), "error: " with a space (the space keeps D-Bus names like
# "GDBus.Error:org..." from matching), "failed to", "fatal", crashes.
ERR_RE='\[error\]|\berr: |\berror: |failed to|fatal|panic|segmentation fault'
# Ignored error lines. Each one is expected in a container and is logged in the summary, never hidden.
#   - no /dev/rfkill (waybar wifi module)
#   - GTK's AT-SPI accessibility bus (no a11y bus in a container)
IGNORE_RE="Can't open RFKILL control device|AT-SPI"

[ "$(id -u)" -ne 0 ] || { echo "smoke-tools: run as a normal user (sway refuses root sessions in CI too)" >&2; exit 2; }
for cmd in sway swaymsg grim node waybar foot fuzzel mako swaybg pgrep pkill; do
  command -v "$cmd" >/dev/null || { echo "smoke-tools: '$cmd' is not installed" >&2; exit 2; }
done

rm -rf "$OUT"
mkdir -p "$OUT" "$HOME/.cache"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$(mktemp -d)}"
chmod 700 "$XDG_RUNTIME_DIR"

# ---- headless Sway ----------------------------------------------------------
SWAY_CFG="$OUT/sway-config"
cat > "$SWAY_CFG" <<'EOF'
output * mode 1920x1080
EOF

WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman LIBSEAT_BACKEND=noop \
  sway -V -c "$SWAY_CFG" > "$OUT/sway.log" 2>&1 &
SWAY_PID=$!

# Sway creates its sockets under XDG_RUNTIME_DIR and does not export them to this shell.
# SWAYSOCK is named after the sway PID, so it can be set before sway is ready.
uid="$(id -u)"
export SWAYSOCK="$XDG_RUNTIME_DIR/sway-ipc.$uid.$SWAY_PID.sock"

ready=false
for _ in $(seq 1 30); do
  if swaymsg -t get_outputs >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$SWAY_PID" 2>/dev/null || break
  sleep 1
done
if [ "$ready" != true ]; then
  echo "smoke-tools: sway did not start. See $OUT/sway.log" >&2
  tail -n 40 "$OUT/sway.log" >&2
  exit 1
fi

# The wayland socket only exists once sway is up. Tools need WAYLAND_DISPLAY, and GTK must not fall back to X11.
WL_SOCK=""
for s in "$XDG_RUNTIME_DIR"/wayland-*; do
  case "$s" in *.lock) ;; *) WL_SOCK="$s" ;; esac
done
[ -n "$WL_SOCK" ] || { echo "smoke-tools: no wayland socket under $XDG_RUNTIME_DIR" >&2; exit 1; }
export WAYLAND_DISPLAY="${WL_SOCK##*/}"
export GDK_BACKEND=wayland
echo "WAYLAND_DISPLAY=$WAYLAND_DISPLAY SWAYSOCK=$SWAYSOCK" > "$OUT/env.txt"

cleanup() {
  for tool in waybar foot fuzzel mako swaybg; do pkill -x "$tool" 2>/dev/null || true; done
  kill "$SWAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Start one tool. Each tool reads its own config from the default path the installer writes to,
# except waybar, which takes its two files explicitly.
launch() {
  case "$1" in
    waybar) waybar -c "$HOME/.config/waybar/config.jsonc" -s "$HOME/.config/waybar/style.css" ;;
    foot) foot ;;
    fuzzel)
      # TRACE_WAYLAND=1 logs every Wayland message fuzzel sends and receives (diagnosis only).
      if [ "${TRACE_WAYLAND:-}" = 1 ]; then export WAYLAND_DEBUG=1; fi
      (sleep 3600 | fuzzel) ;;
    mako) mako ;;
    swaybg) swaybg -i "$HOME/.local/share/backgrounds/deskwizard/wallpaper.png" -m fill ;;
  esac
}

# Every client waits for a live compositor before it starts: the Wayland socket exists, an output is
# active, and swaymsg answers. Without this a client can connect while sway is still setting up.
wait_for_sway() {
  for _ in $(seq 1 20); do
    if [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && swaymsg -t get_outputs 2>/dev/null | grep -Eq '"active": ?true'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

summary="$OUT/summary.md"
{
  echo "## Tool smoke test (headless Sway, 1920x1080, ${RUN_SECONDS} s per variant)"
  echo
  echo "| Variant | Result | Warnings | Ignored | Notes |"
  echo "|---|---|---|---|---|"
} > "$summary"
failed=0
ignored_all="$OUT/ignored.txt"
: > "$ignored_all"

mapfile -t VARIANTS < <(node "$ROOT/scripts/smoke-stage.mjs" list)
[ "${#VARIANTS[@]}" -gt 0 ] || { echo "smoke-tools: no variants found (run build-catalog first)" >&2; exit 1; }

for entry in "${VARIANTS[@]}"; do
  read -r tool variant <<< "$entry"
  label="$tool-$variant"
  # ONLY (regex on the label, e.g. ^fuzzel-) limits the run to matching variants.
  if [ -n "${ONLY:-}" ] && ! [[ "$label" =~ $ONLY ]]; then continue; fi
  log="$OUT/$label.log"
  stage="$OUT/stage/$label"

  if ! node "$ROOT/scripts/smoke-stage.mjs" stage "$tool" "$variant" "$stage" > "$OUT/$label.files" 2> "$OUT/$label.stage-error"; then
    echo "| $label | FAIL | - | - | could not stage files: $(tr '\n' ' ' < "$OUT/$label.stage-error") |" >> "$summary"
    failed=$((failed + 1))
    continue
  fi
  cp -r "$stage"/. "$HOME"/

  if ! wait_for_sway; then
    echo "| $label | FAIL | - | - | sway not ready before launch |" >> "$summary"
    failed=$((failed + 1))
    continue
  fi
  launch "$tool" > "$log" 2>&1 &
  pid=$!
  sleep "$RUN_SECONDS"

  status="PASS"
  notes=""
  if ! pgrep -x "$tool" >/dev/null 2>&1; then
    status="FAIL"
    notes="$tool exited within ${RUN_SECONDS}s"
  fi

  grep -iE "$ERR_RE" "$log" > "$OUT/$label.matched" || true
  grep -viE "$IGNORE_RE" "$OUT/$label.matched" > "$OUT/$label.errors" || true
  grep -iE "$IGNORE_RE" "$OUT/$label.matched" > "$OUT/$label.ignored" || true
  if [ -s "$OUT/$label.errors" ]; then
    status="FAIL"
    notes="${notes:+$notes; }error lines in log"
  fi
  # Every ignored line goes to the summary, with its variant, so it is never silently dropped.
  sed "s/^/$label: /" "$OUT/$label.ignored" >> "$ignored_all"

  if [ "$status" = PASS ]; then
    grim "$OUT/$label.png" || { status="FAIL"; notes="${notes:+$notes; }grim could not take a screenshot"; }
  fi

  # On failure keep what a diagnosis needs: the runtime dir listing and the end of the sway log.
  if [ "$status" = FAIL ]; then
    ls -la "$XDG_RUNTIME_DIR" > "$OUT/$label.runtime-ls.txt" 2>&1
    tail -n 80 "$OUT/sway.log" > "$OUT/$label.sway-tail.txt"
  fi

  grep -i 'warn' "$log" > "$OUT/$label.warnings" || true
  warnings="$(wc -l < "$OUT/$label.warnings")"
  ignored="$(wc -l < "$OUT/$label.ignored")"
  echo "| $label | $status | $warnings | $ignored | ${notes:-ok} |" >> "$summary"
  echo "$label: $status${notes:+ ($notes)}; warnings: $warnings; ignored: $ignored"

  pkill -x "$tool" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  # Let the client close its Wayland connection before the next variant connects. Starting the
  # next client while this one is still tearing down made the next fuzzel fail in CI.
  for _ in $(seq 1 10); do pgrep -x "$tool" >/dev/null 2>&1 || break; sleep 1; done
  [ "$status" = PASS ] || failed=$((failed + 1))
done

{
  echo
  echo "### Ignored log lines (expected in a container, not failures)"
  if [ -s "$ignored_all" ]; then sed 's/^/- /' "$ignored_all"; else echo "- none"; fi
  echo
  echo "### Warning lines (not failures)"
  for w in "$OUT"/*.warnings; do
    [ -s "$w" ] || continue
    sed "s|^|- $(basename "$w" .warnings): |" "$w"
  done
  echo
  echo "**$failed variant(s) failed.**"
} >> "$summary"

cat "$summary"
echo "smoke-tools: $failed variant(s) failed. Outputs in $OUT"
[ "$failed" -eq 0 ]
