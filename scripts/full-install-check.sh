#!/usr/bin/env bash
# Full-install check (CI job "full-install", debian:trixie, run as a normal user with sudo).
#
#   1. run the generated installer for real (not --dry-run)
#   2. check the generated sway config with `sway -C`
#   3. start headless Sway on that config, wait 10 s
#   4. start a notification and a foot window
#   5. screenshot the whole screen (bar, wallpaper, foot window, notification)
#   6. fail if any of the desktop programs is not running at the end
#
# Outputs go to $OUT (default: ./full-install-out): install.log, sway-check.log, sway.log,
# full-install.png, summary.md.
# Usage: bash scripts/full-install-check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/full-install-out}"
INSTALLER="$ROOT/site/public/v1/install.sh"
SWAY_CFG="$HOME/.config/sway/config"
SUMMARY="$OUT/summary.md"

[ "$(id -u)" -ne 0 ] || { echo "full-install: run as a normal user (the installer refuses root)" >&2; exit 2; }
[ -s "$INSTALLER" ] || { echo "full-install: $INSTALLER is missing. Run npm run build first." >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT" "$HOME/.cache"
fail=0
note() { echo "$1" | tee -a "$SUMMARY"; }
{
  echo "## Full install check (debian:trixie, real installer, headless Sway)"
  echo
} > "$SUMMARY"

# 1. Real install. Nothing is skipped. The installer runs from the local build (file:// base, a
# test-only hook) with the default build code, so the artifact tested is the one just built.
CODE="$(cd "$ROOT" && node scripts/ci-helpers.mjs code manual)" || { note "- build code: FAIL"; exit 1; }
if DESKWIZARD_TEST_MODE=1 DESKWIZARD_TEST_BASE_URL="file://$ROOT/site/public/v1" \
  bash "$INSTALLER" --build "$CODE" > "$OUT/install.log" 2>&1; then
  note "- installer: PASS"
else
  note "- installer: FAIL (exit $?). Last lines of install.log:"
  tail -n 30 "$OUT/install.log" | sed 's/^/    /' | tee -a "$SUMMARY"
  exit 1
fi

# 2. Config check. `sway -C` parses the file and exits non-zero on any error.
# sway refuses to start without XDG_RUNTIME_DIR, even for a config check.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$(mktemp -d)}"
chmod 700 "$XDG_RUNTIME_DIR"
if [ -s "$SWAY_CFG" ] && WLR_BACKENDS=headless LIBSEAT_BACKEND=noop sway -C -c "$SWAY_CFG" > "$OUT/sway-check.log" 2>&1; then
  note "- sway -C on $SWAY_CFG: PASS"
else
  note "- sway -C on $SWAY_CFG: FAIL"
  cat "$OUT/sway-check.log" 2>/dev/null | sed 's/^/    /' | tee -a "$SUMMARY"
  exit 1
fi

# 3. Headless Sway with the installed config (same backend settings as scripts/smoke-tools.sh).
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman LIBSEAT_BACKEND=noop \
  sway -V -c "$SWAY_CFG" > "$OUT/sway.log" 2>&1 &
SWAY_PID=$!
export SWAYSOCK="$XDG_RUNTIME_DIR/sway-ipc.$(id -u).$SWAY_PID.sock"

cleanup() {
  for tool in foot mako waybar swaybg; do pkill -x "$tool" 2>/dev/null || true; done
  kill "$SWAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

ready=false
for _ in $(seq 1 30); do
  if swaymsg -t get_outputs >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$SWAY_PID" 2>/dev/null || break
  sleep 1
done
if [ "$ready" != true ]; then
  note "- sway did not start: FAIL (see sway.log)"
  tail -n 40 "$OUT/sway.log" | sed 's/^/    /' | tee -a "$SUMMARY"
  exit 1
fi
WL_SOCK=""
for s in "$XDG_RUNTIME_DIR"/wayland-*; do
  case "$s" in *.lock) ;; *) WL_SOCK="$s" ;; esac
done
[ -n "$WL_SOCK" ] || { note "- no wayland socket: FAIL"; exit 1; }
export WAYLAND_DISPLAY="${WL_SOCK##*/}" GDK_BACKEND=wayland

# 4. The config autostarts the bar, notifications and wallpaper. Add a notification and a terminal.
# Float the terminal so the wallpaper and bar stay visible around it.
# Screenshot size: 1920x1080 (the headless output defaults to a smaller mode).
swaymsg 'output * mode 1920x1080' >/dev/null
swaymsg 'for_window [app_id="foot"] floating enable, resize set width 900 px height 500 px, move position center' >/dev/null
swaymsg exec foot >/dev/null
# -t 60000: a mako variant may expire notifications after 3-6 s, before the screenshot.
notify-send -t 60000 "deskwizard" "Full install check: notifications work" 2>> "$OUT/notify.log" || fail=1

# 5. Wait 10 s, then screenshot the whole screen.
sleep 10
# The notification must be known to mako, not only sent.
{
  echo "== makoctl version / list / history (diagnostics)"
  echo "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unset}"
  echo "-- list"; makoctl list 2>&1 || true
  echo "-- history"; makoctl history 2>&1 || true
} >> "$OUT/notify.log"
# mako's list shows the summary and app name, not the body, so match the summary.
if makoctl list 2>> "$OUT/notify.log" | grep -q "Notification [0-9]*: deskwizard"; then
  note "- mako shows the check notification: PASS"
else
  note "- mako shows the check notification: FAIL (see notify.log)"
  fail=1
fi
# lxpolkit (the polkit agent the config starts) shows an error dialog in a container without a logind session.
# Close only that dialog so it does not cover the screenshot, and log it in the summary.
if swaymsg -t get_tree | grep -q '"app_id": "lxpolkit"'; then
  note "- ignored: lxpolkit error dialog (no logind session in the container) closed before the screenshot"
  swaymsg '[app_id="lxpolkit"] kill' >/dev/null 2>&1 || true
  sleep 1
fi
grim "$OUT/full-install.png" 2>> "$OUT/grim.log" || fail=1

# 5b. Bind checks. Run the exact command each bind in the installed config runs (no keypress is sent).
# slurp is stubbed to print a fixed region. pactl, brightnessctl and playerctl are stubbed to log their
# arguments, so the media keys are checked without audio or brightness hardware. Screenshots are saved to
# ~/Pictures/Screenshots. The check removes that folder first, so the bind must create it. CI only: the
# check runs in a fresh container.
BIND_BIN="$OUT/bind-bin"; mkdir -p "$BIND_BIN"
OUT_ABS="$(cd "$OUT" && pwd)"; BIND_LOG="$OUT_ABS/bind-args.log"; : > "$BIND_LOG"
printf '#!/bin/sh\necho "0,0 200x100"\n' > "$BIND_BIN/slurp"
for tool in pactl brightnessctl playerctl; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\n' "$tool" "$BIND_LOG" > "$BIND_BIN/$tool"
done
chmod +x "$BIND_BIN"/*

# The command for one bind, exactly as the installer wrote it after the key.
bind_cmd() { awk -v p="bindsym $1 " 'index($0,p)==1{print substr($0,length(p)+1); exit}' "$SWAY_CFG"; }
# Run the bind's command the way sway runs `exec` (sh -c, with the stubs first on PATH).
run_bind() {
  local cmd; cmd="$(bind_cmd "$1")"
  if [ -z "$cmd" ]; then note "- bind $1 in $SWAY_CFG: FAIL (not found)"; fail=1; return 1; fi
  PATH="$BIND_BIN:$PATH" sh -c "${cmd#exec }" >> "$OUT_ABS/bind.log" 2>&1
}

SHOTS="$HOME/Pictures/Screenshots"
for key in Print Shift+Print; do
  rm -rf "$SHOTS"
  run_bind "$key" || true
  png=$(find "$SHOTS" -maxdepth 1 -name '*.png' -size +0c 2>/dev/null | head -n 1)
  if [ -n "$png" ] && [ "$(head -c 8 "$png" | od -An -tx1 | tr -d ' \n')" = 89504e470d0a1a0a ]; then
    cp "$png" "$OUT_ABS/bind-$(echo "$key" | tr -c 'A-Za-z0-9' '_').png"
    note "- bind $key saves a non-empty PNG to Pictures/Screenshots (folder created): PASS"
  else
    note "- bind $key saves a non-empty PNG to Pictures/Screenshots: FAIL"
    fail=1
  fi
done

# Media keys: each bind must call its tool with the expected arguments.
check_media() {
  : > "$BIND_LOG"
  run_bind "$1" || true
  if grep -qxF -- "$2" "$BIND_LOG"; then
    note "- bind $1 runs '$2': PASS"
  else
    note "- bind $1 runs '$2': FAIL (logged: $(tr '\n' ';' < "$BIND_LOG"))"
    fail=1
  fi
}
check_media XF86AudioRaiseVolume "pactl set-sink-volume @DEFAULT_SINK@ +5%"
check_media XF86AudioLowerVolume "pactl set-sink-volume @DEFAULT_SINK@ -5%"
check_media XF86AudioMute "pactl set-sink-mute @DEFAULT_SINK@ toggle"
check_media XF86MonBrightnessUp "brightnessctl set +5%"
check_media XF86MonBrightnessDown "brightnessctl set 5%-"
check_media XF86AudioPlay "playerctl play-pause"
check_media XF86AudioNext "playerctl next"
check_media XF86AudioPrev "playerctl previous"

# 6. Every desktop program the config starts must still be running.
for tool in waybar mako swaybg foot; do
  if pgrep -x "$tool" >/dev/null 2>&1; then
    note "- $tool running: PASS"
  else
    note "- $tool running: FAIL"
    fail=1
  fi
done
# The PNG header (IHDR) holds width and height as 4-byte big-endian numbers at offsets 16 and 20.
# Fail unless the screenshot is exactly 1920x1080.
if [ -s "$OUT/full-install.png" ] && [ "$(head -c 8 "$OUT/full-install.png" | od -An -tx1 | tr -d ' \n')" = 89504e470d0a1a0a ]; then
  w=$(od -An -t u1 -j 16 -N 4 "$OUT/full-install.png" | awk '{print $1*16777216+$2*65536+$3*256+$4}')
  h=$(od -An -t u1 -j 20 -N 4 "$OUT/full-install.png" | awk '{print $1*16777216+$2*65536+$3*256+$4}')
  if [ "$w" = 1920 ] && [ "$h" = 1080 ]; then
    note "- screenshot full-install.png is 1920x1080: PASS"
  else
    note "- screenshot full-install.png is ${w}x${h}, expected 1920x1080: FAIL"
    fail=1
  fi
else
  note "- screenshot full-install.png: FAIL (missing or not a PNG)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then note "**full install check passed.**"; else note "**full install check failed.**"; fi
exit "$fail"
