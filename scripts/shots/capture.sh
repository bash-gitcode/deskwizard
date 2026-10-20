#!/usr/bin/env bash
# Scene captures for the site. Run after build-catalog.
#
# For every base (scene "base-<id>") and every smoke tool variant (scene "<tool>-<variant>", built on the Quick install
# base with that variant swapped in), this starts a headless Sway at 1920x1080 with the staged tools and a fixed
# demo, and writes raw captures under $OUT/raw/<label>/:
#   target        "base <id>" or "variant <tool> <variant>" (read by crop.py)
#   pre.png       the desktop before any notification
#   desktop.png   the desktop with three notifications (mako) on it
#   launcher.png  the same desktop with fuzzel open on 8 fake app names
#   tree.json, outputs.json, workspaces.json   Sway IPC dumps taken on the desktop scene
# scripts/shots/crop.py turns these into the site images. Demo output is fixed so the images are reproducible.
# Usage: bash scripts/shots/capture.sh     (needs sway, swaymsg, grim, jq, notify-send, the five tools; not root)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-$ROOT/scene-raw}"
SCENE_BASE="${SCENE_BASE:-night-bar}"
rm -rf "$OUT"
mkdir -p "$OUT/raw" "$HOME/.cache"

[ "$(id -u)" -ne 0 ] || { echo "capture: run as a normal user" >&2; exit 2; }
for cmd in sway swaymsg grim jq notify-send node waybar foot fuzzel mako swaybg pgrep pkill; do
  command -v "$cmd" >/dev/null || { echo "capture: '$cmd' is not installed" >&2; exit 2; }
done

# Fixed demo for the two foot windows: colored listing, colored text and a color block.
DEMO="$OUT/demo.sh"
cat > "$DEMO" <<'EOF'
ls --color=always /usr/share | head -n 12
echo "deskwizard demo"
printf '\033[31mred \033[32mgreen \033[33myellow \033[34mblue \033[35mmagenta \033[36mcyan\033[0m\n'
printf '\033[41m    \033[42m    \033[43m    \033[44m    \033[45m    \033[46m    \033[0m\n'
exec sleep 3600
EOF

FAILS=()
LAUNCHER_APPS=$'Firefox\nFiles\nTerminal\nSettings\nCalculator\nImage Viewer\nText Editor\nMusic'

# Stop every client and the compositor, and wait until they are gone.
stop_session() {
  for tool in fuzzel waybar foot mako swaybg; do pkill -x "$tool" 2>/dev/null || true; done
  pkill -x sleep 2>/dev/null || true
  if [ -n "${SWAY_PID:-}" ]; then
    kill "$SWAY_PID" 2>/dev/null || true
    wait "$SWAY_PID" 2>/dev/null || true
  fi
  unset SWAY_PID
}
trap stop_session EXIT

# Launches Sway with the given scene's config and sets WAYLAND_DISPLAY and SWAYSOCK. Returns 1 if it did not start.
start_sway() {
  local raw="$1"
  export XDG_RUNTIME_DIR="$(mktemp -d)"
  chmod 700 "$XDG_RUNTIME_DIR"
  printf 'output * mode 1920x1080\n' > "$raw/sway-config"
  # A stale SWAYSOCK from an earlier scene pointed swaymsg at a socket that never answered. Clear it, let Sway
  # create its own IPC socket, then use the socket that exists (the same way the smoke test starts Sway).
  unset SWAYSOCK
  env -u SWAYSOCK WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman LIBSEAT_BACKEND=noop \
    sway -V -c "$raw/sway-config" > "$raw/sway.log" 2>&1 &
  SWAY_PID=$!
  local ipc=""
  for _ in $(seq 1 30); do
    for s in "$XDG_RUNTIME_DIR"/sway-ipc.*.sock; do
      [ -S "$s" ] && ipc="$s"
    done
    if [ -n "$ipc" ] && SWAYSOCK="$ipc" swaymsg -t get_outputs >/dev/null 2>&1; then break; fi
    kill -0 "$SWAY_PID" 2>/dev/null || return 1
    sleep 1
  done
  [ -n "$ipc" ] && SWAYSOCK="$ipc" swaymsg -t get_outputs >/dev/null 2>&1 || return 1
  export SWAYSOCK="$ipc"
  local sock=""
  for s in "$XDG_RUNTIME_DIR"/wayland-*; do
    case "$s" in *.lock) ;; *) sock="$s" ;; esac
  done
  [ -n "$sock" ] || return 1
  export WAYLAND_DISPLAY="${sock##*/}"
  export GDK_BACKEND=wayland
}

# Waits until the active output is up, the way the smoke test does before it starts a client.
wait_for_output() {
  for _ in $(seq 1 20); do
    if swaymsg -t get_outputs 2>/dev/null | grep -Eq '"active": ?true'; then return 0; fi
    sleep 1
  done
  return 1
}

run_scene() { # run_scene LABEL BASE [TOOL VARIANT]
  local label="$1" base="$2" tool="${3:-}" variant="${4:-}"
  local raw="$OUT/raw/$label" stage="$OUT/stage/$label"
  mkdir -p "$raw"
  if [ -n "$tool" ]; then echo "variant $tool $variant" > "$raw/target"; else echo "base $base" > "$raw/target"; fi

  if ! node "$ROOT/scripts/smoke-stage.mjs" scene "$stage" "$base" $tool $variant > "$raw/files.txt" 2> "$raw/stage-error.txt"; then
    FAILS+=("$label: could not stage files: $(tr '\n' ' ' < "$raw/stage-error.txt")")
    return
  fi
  # Each scene starts from a clean set of config folders, so a previous variant's files cannot leak in.
  rm -rf "$HOME/.config/waybar" "$HOME/.config/foot" "$HOME/.config/fuzzel" "$HOME/.config/mako" "$HOME/.local/share/backgrounds/deskwizard"
  cp -r "$stage"/. "$HOME"/

  if ! start_sway "$raw"; then
    FAILS+=("$label: sway did not start (see $raw/sway.log)")
    stop_session
    return
  fi
  if ! wait_for_output; then
    FAILS+=("$label: no active output")
    stop_session
    return
  fi

  swaybg -i "$HOME/.local/share/backgrounds/deskwizard/wallpaper.png" -m fill > "$raw/swaybg.log" 2>&1 &
  waybar -c "$HOME/.config/waybar/config.jsonc" -s "$HOME/.config/waybar/style.css" > "$raw/waybar.log" 2>&1 &
  mako > "$raw/mako.log" 2>&1 &
  foot sh "$DEMO" > /dev/null 2>&1 &
  sleep 2
  foot sh "$DEMO" > /dev/null 2>&1 &
  sleep 4

  local missing=""
  for t in swaybg waybar mako foot; do pgrep -x "$t" >/dev/null || missing="$missing $t"; done
  if [ -n "$missing" ]; then
    FAILS+=("$label: not running before the capture:$missing (see $raw/*.log)")
  fi

  swaymsg -t get_tree > "$raw/tree.json" 2>/dev/null
  swaymsg -t get_outputs > "$raw/outputs.json" 2>/dev/null
  swaymsg -t get_workspaces > "$raw/workspaces.json" 2>/dev/null
  grim "$raw/pre.png" || FAILS+=("$label: grim failed on pre.png")

  notify-send -u low -t 600000 "Backup finished" "Documents copied to the drive." 2>/dev/null
  notify-send -u normal -t 600000 "Volume" "Output set to 60%" 2>/dev/null
  notify-send -u critical -t 600000 "Battery low" "12% left, plug in soon" 2>/dev/null
  sleep 2
  grim "$raw/desktop.png" || FAILS+=("$label: grim failed on desktop.png")

  (printf '%s\n' "$LAUNCHER_APPS"; sleep 3600) | fuzzel --dmenu > /dev/null 2>&1 &
  sleep 2
  grim "$raw/launcher.png" || FAILS+=("$label: grim failed on launcher.png")

  stop_session
}

mapfile -t SCENES < <(node "$ROOT/scripts/smoke-stage.mjs" shot-list)
[ "${#SCENES[@]}" -gt 0 ] || { echo "capture: no scenes (run build-catalog first)" >&2; exit 1; }
for entry in "${SCENES[@]}"; do
  read -r kind first second <<< "$entry"
  if [ "$kind" = base ]; then
    run_scene "base-$first" "$first"
  else
    run_scene "$first-$second" "$SCENE_BASE" "$first" "$second"
  fi
done

# The IPC keys that Sway reports, so the job summary shows exactly what the crop code can use.
jq -r '[.. | objects | keys[]] | unique | join(", ")' "$OUT"/raw/base-*/tree.json 2>/dev/null | head -n 1 > "$OUT/ipc-tree-keys.txt"
{
  echo "### Sway IPC keys (get_tree, first scene)"
  echo
  cat "$OUT/ipc-tree-keys.txt"
  echo
  echo "### get_outputs and get_workspaces (first scene)"
  echo
  echo '```json'
  first_raw="$(ls -d "$OUT"/raw/base-* | head -n 1)"
  jq -c '[.[] | {name, active, rect}]' "$first_raw/outputs.json"
  jq -c '[.[] | {name, output, visible, rect}]' "$first_raw/workspaces.json"
  echo '```'
} > "$OUT/ipc-report.md"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$OUT/ipc-report.md" >> "$GITHUB_STEP_SUMMARY"

if [ "${#FAILS[@]}" -gt 0 ]; then
  echo "capture: ${#FAILS[@]} scene problem(s):" >&2
  for f in "${FAILS[@]}"; do echo "  $f" >&2; done
  exit 1
fi
echo "capture: all scenes captured in $OUT/raw"
