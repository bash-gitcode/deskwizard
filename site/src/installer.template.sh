#!/usr/bin/env bash
# =============================================================================
# deskwizard installer: Debian 13 "trixie" + Sway + Waybar
#
# Generated from the choices you made in the deskwizard wizard.
# Read it before you run it. It only writes files under your home directory
# and uses sudo for apt-get.
#
# Usage:
#   bash install.sh                       install the build in this file
#   bash install.sh --dry-run             print every step, change nothing
#   bash install.sh --script <base64>     run a build passed by the one-liner
#                                         (used by https://.../v1/install.sh)
#
# Before a config file is replaced, the old copy is saved to
# ~/.config-backup/<timestamp>/ with the same relative path.
# =============================================================================
set -euo pipefail

# ---- bootstrap: the one-liner passes a build as base64 via --script ----------
# Decodes it to a temporary file, runs it with the remaining arguments, then removes it.
if [ "${1:-}" = "--script" ]; then
  [ -n "${2:-}" ] || { printf 'ERROR: --script needs base64 data\n' >&2; exit 1; }
  bootstrap_tmp="$(mktemp)"
  printf '%s' "$2" | base64 -d > "$bootstrap_tmp"
  shift 2
  bootstrap_rc=0
  bash "$bootstrap_tmp" "$@" </dev/null || bootstrap_rc=$?
  rm -f "$bootstrap_tmp"
  exit "$bootstrap_rc"
fi

# ---- choices from the wizard ------------------------------------------------
# Debian 13 package names, verified with apt-cache policy in a debian:trixie container.
PACKAGES=( @@PACKAGES@@ )

# Font. INSTALL_FONT=false means the font comes from apt (fonts-font-awesome) only.
INSTALL_FONT="@@INSTALL_FONT@@"
FONT_NAME="@@FONT_NAME@@"

# Pinned Nerd Font release, from the official GitHub release.
# The sha256 matches SHA-256.txt published with that release.
NERD_FONT_VERSION="@@FONT_VERSION@@"
NERD_FONT_ARCHIVE="@@FONT_ARCHIVE@@"
NERD_FONT_SHA256="@@FONT_SHA256@@"
NERD_FONT_DEST="@@FONT_DEST@@"
NERD_FONT_FALLBACK_PKG="@@FONT_FALLBACK@@"

BACKUP_DIR="$HOME/.config-backup/$(date +%Y%m%d-%H%M%S)"
DRY_RUN=false

# ---- helpers ----------------------------------------------------------------
log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# run CMD...: run the command, or only print it in --dry-run mode.
run() {
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# backup_existing PATH: copy PATH into BACKUP_DIR before it is replaced.
backup_existing() {
  local target="$1" rel
  [ -e "$target" ] || return 0
  rel="${target#"$HOME"/}"
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] back up %s to %s/%s\n' "$target" "$BACKUP_DIR" "$rel"
    return 0
  fi
  mkdir -p "$(dirname "$BACKUP_DIR/$rel")"
  cp -a "$target" "$BACKUP_DIR/$rel"
  log "backed up $target"
}

# write_file PATH: reads the new contents from stdin and writes PATH.
write_file() {
  local target="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  backup_existing "$target"
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] write %s (%s lines)\n' "$target" "$(wc -l < "$tmp")"
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  chmod 0644 "$tmp"
  mv "$tmp" "$target"
  log "wrote $target"
}

# ---- checks -----------------------------------------------------------------
check_user() {
  if [ "$(id -u)" -eq 0 ]; then
    die "run this as your normal user, not root. sudo is used where needed."
  fi
}

check_os() {
  [ -r /etc/os-release ] || die "/etc/os-release not found, so the distro cannot be checked. Nothing was changed."
  # shellcheck source=/dev/null
  . /etc/os-release
  if [ "${ID:-}" != "debian" ] || [ "${VERSION_ID:-}" != "13" ]; then
    die "this installer needs Debian 13 (trixie). Detected: ${PRETTY_NAME:-unknown}. Nothing was changed."
  fi
  log "Detected ${PRETTY_NAME}"
}

# ---- install steps ----------------------------------------------------------
install_packages() {
  local pkg missing=()
  for pkg in "${PACKAGES[@]}"; do
    if ! dpkg -s "$pkg" 2>/dev/null | grep -q '^Status: install ok installed'; then
      missing+=("$pkg")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    log "All packages are already installed."
    return 0
  fi
  log "Installing packages: ${missing[*]}"
  run sudo apt-get update
  run sudo apt-get install -y "${missing[@]}"
}

install_nerd_font() {
  local url="https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONT_VERSION}/${NERD_FONT_ARCHIVE}"
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] download %s\n' "$url"
    printf '[dry-run] verify sha256 %s\n' "$NERD_FONT_SHA256"
    printf '[dry-run] extract %s to %s and run fc-cache\n' "$FONT_NAME" "$NERD_FONT_DEST"
    return 0
  fi

  local tmp
  tmp="$(mktemp -d)"
  if ! curl -fsSL -o "$tmp/$NERD_FONT_ARCHIVE" "$url"; then
    warn "could not download $FONT_NAME. Installing ${NERD_FONT_FALLBACK_PKG} instead."
    rm -rf "$tmp"
    sudo apt-get install -y "$NERD_FONT_FALLBACK_PKG"
    return 0
  fi

  if ! printf '%s  %s\n' "$NERD_FONT_SHA256" "$tmp/$NERD_FONT_ARCHIVE" | sha256sum -c --status -; then
    rm -rf "$tmp"
    die "checksum mismatch for $NERD_FONT_ARCHIVE. Nothing was installed from it."
  fi

  mkdir -p "$NERD_FONT_DEST"
  tar -xJf "$tmp/$NERD_FONT_ARCHIVE" -C "$NERD_FONT_DEST"
  rm -rf "$tmp"
  fc-cache -f "$HOME/.local/share/fonts" >/dev/null
  log "Installed $FONT_NAME to $NERD_FONT_DEST"
}

write_files() {
  log "Writing config files"
# @@FILES@@
}

# ---- main -------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      printf 'Usage: bash install.sh [--dry-run]\n'
      exit 0
      ;;
    *) die "unknown option: $arg" ;;
  esac
done

main() {
  if [ "$DRY_RUN" = true ]; then
    log "DRY RUN: nothing will be changed"
  fi
  check_user
  check_os
  install_packages
  if [ "$INSTALL_FONT" = true ]; then
    install_nerd_font
  fi
  write_files

  printf '\n'
  if [ "$DRY_RUN" = true ]; then
    log "Dry run complete. Nothing was changed."
  else
    log "Installation complete."
    if [ -d "$BACKUP_DIR" ]; then
      log "Old configs were saved to $BACKUP_DIR"
    fi
  fi
# @@CHEATSHEET@@
  printf '%s\n' "Log out, then run \`sway\` from the TTY."
}

main "$@"
