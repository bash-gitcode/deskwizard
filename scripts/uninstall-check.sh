#!/usr/bin/env bash
# Uninstall check (CI job "uninstall", debian:trixie, run as a normal user with passwordless sudo).
#
# 1. Seed ~/.profile and /etc/greetd/config.toml with known content.
# 2. Install the tty1 build (adds the marked block to ~/.profile).
# 3. Install the greetd build (backs up ~/.profile, with the block, and /etc/greetd/config.toml).
# 4. Run uninstall.sh. It restores the LATEST backup (the greetd run).
# 5. Assert: no deskwizard block in ~/.profile, ~/.profile equals the seeded content,
#    /etc/greetd/config.toml equals the seeded content (restored with sudo), and every home
#    file in the latest backup matches what was restored.
# Outputs go to $OUT (default: ./uninstall-out): install-tty1.log, install-greetd.log, uninstall.log, summary.md.
# Usage: bash scripts/uninstall-check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/uninstall-out}"
V1="$ROOT/site/public/v1"
SUMMARY="$OUT/summary.md"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ "$(id -u)" -ne 0 ] || { echo "uninstall-check: run as a normal user (the installer refuses root)" >&2; exit 2; }
[ -s "$V1/install.sh" ] && [ -s "$V1/uninstall.sh" ] || { echo "uninstall-check: run npm run build first" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT"
fail=0
note() { echo "$1" | tee -a "$SUMMARY"; }
check() { # check "description" command...
  local desc="$1"; shift
  if "$@"; then note "- $desc: PASS"; else note "- $desc: FAIL"; fail=1; fi
}
{ echo "## Uninstall check (debian:trixie, greetd build over tty1 build, real uninstall.sh)"; echo; } > "$SUMMARY"

# 1. Seed the files the installs touch.
printf '# original profile\nexport DESKWIZARD_CHECK_KEEP=1\n' > "$HOME/.profile"
cp "$HOME/.profile" "$WORK/profile.seed"
sudo mkdir -p /etc/greetd
printf '# original greetd config\n' | sudo tee /etc/greetd/config.toml > /dev/null
cp /etc/greetd/config.toml "$WORK/greetd.seed"

install_build() { # install_build METHOD LOG
  local code
  code="$(node "$ROOT/scripts/ci-helpers.mjs" code "$1")" || return 1
  DESKWIZARD_TEST_MODE=1 DESKWIZARD_TEST_BASE_URL="file://$V1" \
    bash "$V1/install.sh" --build "$code" > "$OUT/$2" 2>&1
}

# 2. tty1 build, then 3. greetd build. The sleep keeps the two backup folder names apart.
check "tty1 install exits 0" install_build tty1 install-tty1.log
check "tty1 install added the marked block to ~/.profile (so the uninstall has something to remove)" \
  grep -q '^# BEGIN deskwizard$' "$HOME/.profile"
sleep 2
check "greetd install exits 0" install_build greetd install-greetd.log

# 4. Uninstall.
bash "$V1/uninstall.sh" > "$OUT/uninstall.log" 2>&1
check "uninstall.sh exits 0" test $? -eq 0

# 5. Assertions.
check "no deskwizard block left in ~/.profile" \
  bash -c "! grep -q '^# BEGIN deskwizard\$' \"\$HOME/.profile\" && ! grep -q '^# END deskwizard\$' \"\$HOME/.profile\""
check "~/.profile equals the seeded content" cmp -s "$HOME/.profile" "$WORK/profile.seed"
check "/etc/greetd/config.toml restored to the seeded content (sudo restore ran)" \
  bash -c "sudo cmp -s /etc/greetd/config.toml '$WORK/greetd.seed'"

# Every home file in the latest backup must match the restored file.
LATEST="$(find "$HOME/.config-backup" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
homefiles=0; bad=0
while IFS= read -r -d '' f; do
  rel="${f#"$LATEST"/}"
  case "$rel" in system/*|.profile) continue ;; esac
  homefiles=$((homefiles + 1))
  cmp -s "$f" "$HOME/$rel" || { bad=$((bad + 1)); echo "    differs: $HOME/$rel" >> "$SUMMARY"; }
done < <(find "$LATEST" -type f -print0)
if [ "$homefiles" -gt 0 ] && [ "$bad" -eq 0 ]; then
  note "- $homefiles home file(s) from the latest backup restored: PASS"
else
  note "- home files from the latest backup restored ($homefiles checked, $bad differ): FAIL"; fail=1
fi

if [ "$fail" -eq 0 ]; then note "**uninstall check passed.**"; else note "**uninstall check failed.** See uninstall.log."; fi
exit "$fail"
