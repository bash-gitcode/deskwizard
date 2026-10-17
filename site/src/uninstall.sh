#!/usr/bin/env bash
# =============================================================================
# deskwizard uninstaller. Undoes what install.sh changed, as far as backups allow.
#
# 1. Restores every file from the latest backup in ~/.config-backup/<timestamp>/.
#    Files under ~/.config-backup/<timestamp>/system/ are restored with sudo.
# 2. Removes the block between "# BEGIN deskwizard" and "# END deskwizard" from ~/.profile.
#
# It does NOT uninstall packages and does NOT delete files that had no backup
# (for example a new /etc/greetd/config.toml). Remove those by hand if you want.
#
# Usage:  bash uninstall.sh [--dry-run]
# =============================================================================
set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help) printf 'Usage: bash uninstall.sh [--dry-run]\n'; exit 0 ;;
    *) printf 'ERROR: unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root."

BACKUP_ROOT="$HOME/.config-backup"
[ -d "$BACKUP_ROOT" ] || die "no backups found in $BACKUP_ROOT. Nothing was changed."
LATEST="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
[ -n "$LATEST" ] || die "no backups found in $BACKUP_ROOT. Nothing was changed."
log "Latest backup: $LATEST"

restore_tree() {
  local src="$1" root="$2" use_sudo="$3" rel dest
  while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    dest="$root/$rel"
    if [ "$DRY_RUN" = true ]; then
      printf '[dry-run] restore %s to %s\n' "$f" "$dest"
    elif [ "$use_sudo" = sudo ]; then
      sudo mkdir -p "$(dirname "$dest")"
      sudo cp -a "$f" "$dest"
      log "restored $dest"
    else
      mkdir -p "$(dirname "$dest")"
      cp -a "$f" "$dest"
      log "restored $dest"
    fi
  done < <(find "$src" -type f -print0)
}

# Home files first (the system/ folder is skipped here, it is restored below).
if [ -d "$LATEST" ]; then
  while IFS= read -r -d '' f; do
    rel="${f#"$LATEST"/}"
    case "$rel" in system/*) continue ;; esac
    dest="$HOME/$rel"
    if [ "$DRY_RUN" = true ]; then
      printf '[dry-run] restore %s to %s\n' "$f" "$dest"
    else
      mkdir -p "$(dirname "$dest")"
      cp -a "$f" "$dest"
      log "restored $dest"
    fi
  done < <(find "$LATEST" -type f -print0)
fi
# Remove the marked block from ~/.profile. This runs before the system restore, so a sudo
# failure there cannot leave the block behind.
PROFILE="$HOME/.profile"
if [ -f "$PROFILE" ] && grep -q '^# BEGIN deskwizard$' "$PROFILE"; then
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] remove the deskwizard block from %s\n' "$PROFILE"
  else
    tmp="$(mktemp)"
    sed '/^# BEGIN deskwizard$/,/^# END deskwizard$/d' "$PROFILE" > "$tmp"
    cat "$tmp" > "$PROFILE"
    rm -f "$tmp"
    log "removed the deskwizard block from $PROFILE"
  fi
fi

if [ -d "$LATEST/system" ]; then
  restore_tree "$LATEST/system" "" sudo
fi

if [ "$DRY_RUN" = true ]; then
  log "Dry run complete. Nothing was changed."
else
  log "Uninstall complete. Packages were not removed."
fi
