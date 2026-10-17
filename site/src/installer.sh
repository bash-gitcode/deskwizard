#!/usr/bin/env bash
# =============================================================================
# deskwizard installer: Debian 13 "trixie", Sway and the tools you picked.
#
# This file is the same for every build. Your choices come from the build code
# (--build). The code is DATA only: this script never evals, sources or runs any
# part of it, and it never runs a downloaded file. Every id in the code must be
# listed in manifest.json, and every downloaded file must match the sha256 that
# manifest.json gives for it. Nothing is written until all checks have passed.
#
# Usage:
#   curl -fsSL https://bash-gitcode.github.io/deskwizard/v1/install.sh | bash -s -- --build <code>
#   bash install.sh --build <code> --dry-run      print every step, change nothing
#
# Before a file is replaced, the old copy goes to ~/.config-backup/<timestamp>/
# (files outside your home folder go under <timestamp>/system/).
# =============================================================================
set -euo pipefail

SITE_BASE="https://bash-gitcode.github.io/deskwizard/v1"
# Test hooks. They are read only when DESKWIZARD_TEST_MODE=1, which CI sets. A normal run ignores them.
if [ "${DESKWIZARD_TEST_MODE:-}" = "1" ]; then
  SITE_BASE="${DESKWIZARD_TEST_BASE_URL:-$SITE_BASE}"
  FONT_URL_OVERRIDE="${DESKWIZARD_TEST_FONT_URL:-}"
else
  FONT_URL_OVERRIDE=""
fi

MAX_CODE_LENGTH=4096
MAX_CODE_LINES=64
BAR_EXTRA_PACKAGES=(fontconfig curl xz-utils)

BUILD_CODE=""
DRY_RUN=false
BACKUP_DIR="$HOME/.config-backup/$(date +%Y%m%d-%H%M%S)"
# dpkg keeps an existing conffile (for example /etc/greetd/config.toml) and never prompts. Our file is written
# afterwards by install_file, after the old one is backed up.
APT_OPTS=(-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- helpers ----------------------------------------------------------------
log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# run CMD...: runs the command, or only prints it in --dry-run mode.
run() {
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# backup_existing PATH: copies PATH into BACKUP_DIR before it is replaced.
backup_existing() {
  local target="$1" rel dest
  [ -e "$target" ] || return 0
  if [[ "$target" == "$HOME"/* ]]; then
    rel="${target#"$HOME"/}"
  else
    rel="system${target}"
  fi
  dest="$BACKUP_DIR/$rel"
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] back up %s to %s\n' "$target" "$dest"
    return 0
  fi
  # Create the backup folder as the user. If sudo created it, a later install run as the user could not write to it.
  mkdir -p "$BACKUP_DIR"
  if [[ "$target" == "$HOME"/* ]]; then
    mkdir -p "$(dirname "$dest")"
    cp -a "$target" "$dest"
  else
    sudo mkdir -p "$(dirname "$dest")"
    sudo cp -a "$target" "$dest"
  fi
  log "backed up $target"
}

# install_file TARGET SOURCE [sudo]: backs up TARGET, then copies SOURCE over it with mode 0644.
install_file() {
  local target="$1" src="$2" use_sudo="${3:-}"
  backup_existing "$target"
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] write %s\n' "$target"
    return 0
  fi
  if [ -n "$use_sudo" ]; then
    sudo mkdir -p "$(dirname "$target")"
    sudo install -m 0644 "$src" "$target"
  else
    mkdir -p "$(dirname "$target")"
    install -m 0644 "$src" "$target"
  fi
  log "wrote $target"
}

# ---- manifest and downloads -------------------------------------------------
# manifest_sha PATH: the sha256 that manifest.json lists for PATH (empty if it is not listed).
manifest_sha() {
  { grep -F "\"path\": \"$1\"" "$WORK/manifest.json" || true; } | sed -n 's/.*"sha256": "\([0-9a-f]\{64\}\)".*/\1/p' | sed -n '1p'
}

# fetch REL: downloads SITE_BASE/REL into WORK/REL and checks it against manifest.json. Aborts on any mismatch.
fetch() {
  local rel="$1" expected actual
  expected="$(manifest_sha "$rel")"
  [ -n "$expected" ] || die "$rel is not listed in manifest.json. Nothing was changed."
  mkdir -p "$(dirname "$WORK/$rel")"
  curl -fsSL --retry 2 -o "$WORK/$rel" "$SITE_BASE/$rel" || die "could not download $rel from $SITE_BASE. Nothing was changed."
  actual="$(sha256sum "$WORK/$rel" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $rel (manifest $expected, downloaded $actual). Nothing was changed."
}

# ---- build code (parsed as data) ---------------------------------------------
declare -A CODE=()
declare -A TOOL_VARIANT=()
EXTRAS=()
TOOL_IDS=()

# parse_code: checks the length and characters, decodes base64url, and reads key=value lines. Never runs them.
parse_code() {
  local code="$1" padded line key value lines=0 last
  local re='^(schema|catalog|distro|display|font|palette|start|extra|tool\.[a-z][a-z0-9-]*)=([a-z0-9._-]{1,64})$'
  [ -n "$code" ] || die "the build code is empty. Copy the install command from the wizard's Review step."
  [ "${#code}" -le "$MAX_CODE_LENGTH" ] || die "the build code is longer than $MAX_CODE_LENGTH characters. Nothing was changed."
  case "$code" in
    *[!A-Za-z0-9_-]*) die "the build code is malformed (unexpected characters). Nothing was changed." ;;
  esac
  [ $(( ${#code} % 4 )) -ne 1 ] || die "the build code is malformed (bad length). Nothing was changed."

  padded="${code//-/+}"
  padded="${padded//_//}"
  case $(( ${#code} % 4 )) in
    2) padded+="==" ;;
    3) padded+="=" ;;
  esac
  printf '%s' "$padded" | base64 -d > "$WORK/code.txt" 2>/dev/null || die "the build code is malformed (not base64). Nothing was changed."
  last="$(tail -c1 "$WORK/code.txt"; printf x)"
  [ "$last" = $'\nx' ] || die "the build code is malformed (no line ends). Nothing was changed."

  while IFS= read -r line || [ -n "$line" ]; do
    lines=$((lines + 1))
    [ "$lines" -le "$MAX_CODE_LINES" ] || die "the build code has more than $MAX_CODE_LINES lines. Nothing was changed."
    [[ "$line" =~ $re ]] || die "the build code has a malformed line. Nothing was changed."
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$key" in
      extra)
        for e in "${EXTRAS[@]}"; do
          [ "$e" = "$value" ] && die "the build code lists extra '$value' twice. Nothing was changed."
        done
        EXTRAS+=("$value")
        ;;
      tool.*)
        key="${key#tool.}"
        [ -z "${TOOL_VARIANT[$key]+x}" ] || die "the build code lists tool '$key' twice. Nothing was changed."
        TOOL_VARIANT[$key]="$value"
        TOOL_IDS+=("$key")
        ;;
      *)
        [ -z "${CODE[$key]+x}" ] || die "the build code repeats '$key'. Nothing was changed."
        CODE[$key]="$value"
        ;;
    esac
  done < "$WORK/code.txt"

  for key in schema catalog distro display font palette start; do
    [ -n "${CODE[$key]+x}" ] || die "the build code is missing '$key'. Nothing was changed."
  done
  [ "${CODE[schema]}" = "4" ] || die "unsupported build code schema ${CODE[schema]}. Make the build again in the wizard."
}

# id_known KIND ID: true if manifest.json lists "KIND ID" as an id.
id_known() {
  grep -Fq "\"$1 $2\"" "$WORK/manifest.json"
}

require_id() {
  id_known "$1" "$2" || die "unknown $1 '$2' in the build code (not listed in manifest.json). Nothing was changed."
}

# ---- reading data files -----------------------------------------------------
# meta_list FILE KEY: every value written as KEY=value in FILE.
meta_list() {
  { grep "^$2=" "$1" || true; } | cut -d= -f2-
}
meta_one() {
  meta_list "$1" "$2" | sed -n '1p'
}
# rows FILE TAG: the TAB-separated rows that start with TAG (bind and install rows).
rows() {
  { awk -F'\t' -v t="$2" '$1 == t' "$1" || true; }
}

fetch_data() {
  local t e tag from source v
  fetch "files/distros/${CODE[distro]}.txt"
  fetch "files/palettes/${CODE[palette]}.txt"
  fetch "files/starts/${CODE[start]}.txt"
  fetch "files/fonts/${CODE[font]}.txt"
  for t in "${TOOL_IDS[@]}"; do
    fetch "files/tools/$t.txt"
  done
  for t in "${TOOL_IDS[@]}"; do
    while IFS=$'\t' read -r tag from source target binary; do
      [ "$tag" = install ] || continue
      if [ "$from" = tool ]; then
        fetch "files/tools/$t/src/$source"
      else
        v="${TOOL_VARIANT[$t]}"
        fetch "files/variants/$t/$v/$source"
      fi
    done < <(rows "$WORK/files/tools/$t.txt" install)
  done
  for e in "${EXTRAS[@]}"; do
    fetch "files/extras/$e.txt"
  done
  for t in "${TOOL_IDS[@]}"; do
    for e in $(meta_list "$WORK/files/tools/$t.txt" extra); do
      if [ ! -f "$WORK/files/extras/$e.txt" ]; then
        fetch "files/extras/$e.txt"
      fi
    done
  done
}

# ---- checks and plan (mirrors site/src/generator.js buildPlan) ---------------
ERRORS=()
PKGS=()
add_pkg() {
  local p
  for p in "${PKGS[@]}"; do
    [ "$p" = "$1" ] && return 0
  done
  PKGS+=("$1")
}

check_ids() {
  local v
  grep -q "\"catalog_version\": \"${CODE[catalog]}\"" "$WORK/manifest.json" \
    || die "this build was made with catalog ${CODE[catalog]}, which this installer does not serve. Make the build again in the wizard. Nothing was changed."
  require_id distro "${CODE[distro]}"
  require_id display "${CODE[display]}"
  require_id font "${CODE[font]}"
  require_id palette "${CODE[palette]}"
  require_id start "${CODE[start]}"
  for v in "${EXTRAS[@]}"; do
    require_id extra "$v"
  done
  for v in "${TOOL_IDS[@]}"; do
    require_id tool "$v"
    if [ "${TOOL_VARIANT[$v]}" != "-" ]; then
      id_known variant "$v ${TOOL_VARIANT[$v]}" || die "unknown look '${TOOL_VARIANT[$v]}' for $v in the build code (not listed in manifest.json). Nothing was changed."
    fi
  done
}

# Replaces $tokens in a variant file with palette values. Longest names first, so $accent2 wins over $accent.
render_text() {
  local src="$1" from="$2" dest="$3" text name value
  text="$(cat "$src"; printf x)"
  text="${text%x}"
  if [ "$from" = variant ]; then
    for name in "${TOKEN_NAMES[@]}"; do
      value="${PALETTE[$name]}"
      if [ "${value:0:1}" = "#" ]; then
        text="${text//\$"${name}_hexff"/"${value:1}ff"}"
        text="${text//\$"${name}_hex"/"${value:1}"}"
      fi
      text="${text//\$"$name"/"$value"}"
    done
    if [[ "$text" == *'$'[a-z]* ]]; then
      ERRORS+=("unknown palette token in $src")
    fi
  fi
  text="${text//'"{{NERD_FONT}}", '/"$FONT_FAMILY_PREFIX"}"
  text="${text//'{{BAR_BLOCK}}'/"$BAR_BLOCK"}"
  text="${text//'{{BINDS}}'/"$BINDS_BLOCK"}"
  text="${text//'{{EXEC}}'/"$EXEC_BLOCK"}"
  text="${text//'{{TERM_CMD}}'/"$TERM_CMD"}"
  printf '%s' "$text" > "$dest"
}

build_plan() {
  local t chosen=() compositors=0 bars=0 terminal_cmd="" bar_cmd="" dl_font=false
  local owner ex line key cmd label tag tgt binary i
  local req vreq vid
  local font_family font_archive font_sha
  local -a bind_keys=() bind_cmds=() bind_labels=() bind_owners=() autos=() autos_owner=()
  local -a file_targets=() file_srcs=() file_bins=() file_froms=()
  declare -gA PALETTE=()
  TOKEN_NAMES=()

  # Palette tokens, longest name first.
  while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    PALETTE[$key]="$value"
    TOKEN_NAMES+=("$key")
  done < "$WORK/files/palettes/${CODE[palette]}.txt"
  mapfile -t TOKEN_NAMES < <(printf '%s\n' "${TOKEN_NAMES[@]}" | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)

  # Chosen tools in display order.
  mapfile -t chosen < <(for t in "${TOOL_IDS[@]}"; do printf '%s %s\n' "$(meta_one "$WORK/files/tools/$t.txt" order)" "$t"; done | sort -n | cut -d' ' -f2)

  for t in "${chosen[@]}"; do
    local f="$WORK/files/tools/$t.txt"
    case "$(meta_one "$f" type)" in
      compositor) compositors=$((compositors + 1)) ;;
      bar)
        bars=$((bars + 1))
        bar_cmd="$(meta_one "$f" command)"
        [ "$bar_cmd" = "-" ] && bar_cmd="$t"
        ;;
      terminal) terminal_cmd="$(meta_one "$f" command)" ;;
    esac
    for req in $(meta_list "$f" requires); do
      [ -n "${TOOL_VARIANT[$req]+x}" ] || ERRORS+=("$t needs $req. Add it to the build.")
    done
    vid="${TOOL_VARIANT[$t]}"
    if [ "$vid" = "-" ] && [ -n "$(meta_list "$f" variant | sed -n '1p')" ]; then
      ERRORS+=("$t: pick a look (variant).")
    fi
    while IFS= read -r vreq; do
      [ -n "$vreq" ] || continue
      local want_v="${vreq%% *}" want_t="${vreq#* }"
      if [ "$want_v" = "$vid" ] && [ -z "${TOOL_VARIANT[$want_t]+x}" ]; then
        ERRORS+=("$t '$vid' needs $want_t. Add it to the build.")
      fi
    done < <(meta_list "$f" variant_requires)
  done
  [ "$compositors" -eq 1 ] || ERRORS+=("Choose exactly one compositor (Sway).")
  [ "$(meta_one "$WORK/files/distros/${CODE[distro]}.txt" status)" = "available" ] || ERRORS+=("$(meta_one "$WORK/files/distros/${CODE[distro]}.txt" name) is not available yet.")

  # Font and palette-dependent values.
  font_family="$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" family)"
  font_archive="$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" archive)"
  font_sha="$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" sha256)"
  if [ "$bars" -gt 0 ] && [ "$font_archive" != "-" ]; then dl_font=true; fi
  FONT_FAMILY_PREFIX=""
  if [ "$font_family" != "-" ]; then FONT_FAMILY_PREFIX="\"$font_family\", "; fi
  FONT_ARCHIVE="$font_archive"
  FONT_SHA="$font_sha"
  FONT_DL="$dl_font"
  FONT_NAME="$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" name)"
  FONT_FALLBACK="$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" fallback)"
  FONT_VERSION="$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" version)"
  FONT_DEST="$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" dest_root)/$(meta_one "$WORK/files/fonts/${CODE[font]}.txt" dest)"

  # Packages: distro lists of the chosen tools, extras and start method, then bar extras.
  for t in "${chosen[@]}"; do
    for pkg in $(meta_list "$WORK/files/tools/$t.txt" "package.${CODE[distro]}"); do add_pkg "$pkg"; done
  done

  # Extras: accepted ones plus the ones the chosen tools need, in catalog order.
  local -a wanted=()
  for ex in "${EXTRAS[@]}"; do wanted+=("$ex"); done
  for t in "${chosen[@]}"; do
    for ex in $(meta_list "$WORK/files/tools/$t.txt" extra); do
      case " ${wanted[*]} " in *" $ex "*) ;; *) wanted+=("$ex") ;; esac
    done
  done
  mapfile -t wanted < <(for ex in "${wanted[@]}"; do printf '%s %s\n' "$(meta_one "$WORK/files/extras/$ex.txt" order)" "$ex"; done | sort -n | cut -d' ' -f2)
  for ex in "${wanted[@]}"; do
    for pkg in $(meta_list "$WORK/files/extras/$ex.txt" "package.${CODE[distro]}"); do add_pkg "$pkg"; done
  done
  for pkg in $(meta_list "$WORK/files/starts/${CODE[start]}.txt" "package.${CODE[distro]}"); do add_pkg "$pkg"; done
  if [ "$bars" -gt 0 ]; then
    for pkg in "${BAR_EXTRA_PACKAGES[@]}"; do
      if { [ "$pkg" = curl ] || [ "$pkg" = xz-utils ]; } && [ "$dl_font" != true ]; then continue; fi
      add_pkg "$pkg"
    done
  fi

  # Keybinds and startup lines: chosen tools first, then extras.
  local -a sources=("${chosen[@]}" "${wanted[@]}")
  for owner in "${sources[@]}"; do
    local dir="$WORK/files/tools/$owner.txt"
    [ -f "$dir" ] || dir="$WORK/files/extras/$owner.txt"
    while IFS=$'\t' read -r tag key cmd label; do
      [ "$tag" = bind ] || continue
      for i in "${!bind_keys[@]}"; do
        if [ "${bind_keys[$i]}" = "$key" ]; then
          ERRORS+=("two features use the key $key (${bind_owners[$i]} and $owner).")
        fi
      done
      bind_keys+=("$key"); bind_cmds+=("$cmd"); bind_labels+=("$label"); bind_owners+=("$owner")
    done < <(rows "$dir" bind)
    while IFS= read -r line; do
      autos+=("$line"); autos_owner+=("$owner")
    done < <(meta_list "$dir" autostart)
  done

  # Install rows: target files, rendered from the fetched sources.
  for t in "${chosen[@]}"; do
    vid="${TOOL_VARIANT[$t]}"
    while IFS=$'\t' read -r tag from source tgt binary; do
      [ "$tag" = install ] || continue
      case "$tgt" in
        \~/*) ;;
        *) ERRORS+=("$t writes outside your home folder ($tgt). Refusing to continue.") ;;
      esac
      for i in "${!file_targets[@]}"; do
        [ "${file_targets[$i]}" = "$tgt" ] && ERRORS+=("two selected tools write the same file: $tgt.")
      done
      if [ "$from" = tool ]; then
        file_srcs+=("$WORK/files/tools/$t/src/$source")
      else
        file_srcs+=("$WORK/files/variants/$t/$vid/$source")
      fi
      file_targets+=("$tgt")
      file_bins+=("$binary")
      file_froms+=("$from")
    done < <(rows "$WORK/files/tools/$t.txt" install)
  done

  # Sway blocks, the same text the generator writes into the config.
  if [ "$bars" -gt 0 ]; then
    BAR_BLOCK="bar {"$'\n'"    swaybar_command $bar_cmd"$'\n'"}"
  else
    BAR_BLOCK="# No status bar selected. Sway starts without one."
  fi
  TERM_CMD="${terminal_cmd:-foot}"
  [ "$TERM_CMD" = "-" ] && TERM_CMD="foot"
  BINDS_BLOCK=""
  CHEAT=""
  for i in "${!bind_keys[@]}"; do
    [ "$i" -gt 0 ] && BINDS_BLOCK+=$'\n'
    if [ "${bind_labels[$i]}" != "-" ]; then
      BINDS_BLOCK+="# ${bind_labels[$i]}"$'\n'
      CHEAT+="  $(printf '%-24s' "${bind_keys[$i]//\$mod/Super}") ${bind_labels[$i]}"$'\n'
    fi
    BINDS_BLOCK+="bindsym ${bind_keys[$i]} ${bind_cmds[$i]}"
  done
  EXEC_BLOCK=""
  for i in "${!autos[@]}"; do
    [ "$i" -gt 0 ] && EXEC_BLOCK+=$'\n'
    EXEC_BLOCK+="# started by ${autos_owner[$i]}"$'\n'"exec ${autos[$i]}"
  done
  [ -n "$EXEC_BLOCK" ] || EXEC_BLOCK="# Nothing to start at login."

  # Render every target into WORK/out.
  mkdir -p "$WORK/out"
  for i in "${!file_targets[@]}"; do
    if [ "${file_bins[$i]}" = binary ]; then
      cp "${file_srcs[$i]}" "$WORK/out/$i"
    else
      render_text "${file_srcs[$i]}" "${file_froms[$i]}" "$WORK/out/$i"
    fi
  done

  # Start method packages were added above. Check the chosen start method exists.
  [ -f "$WORK/files/starts/${CODE[start]}.txt" ] || ERRORS+=("unknown start method ${CODE[start]}.")

  if [ "${#ERRORS[@]}" -gt 0 ]; then
    printf 'ERROR: this build cannot be installed:\n' >&2
    for e in "${ERRORS[@]}"; do printf '  - %s\n' "$e" >&2; done
    printf 'Nothing was changed.\n' >&2
    exit 1
  fi

  PLAN_TARGETS=("${file_targets[@]}")
  CHEATSHEET="$CHEAT"
}

show_plan() {
  local i
  log "Build: $(meta_one "$WORK/files/distros/${CODE[distro]}.txt" name), start: ${CODE[start]}, font: ${FONT_NAME}"
  log "Packages (${#PKGS[@]}): ${PKGS[*]}"
  for i in "${!PLAN_TARGETS[@]}"; do
    printf '    file  %s\n' "${PLAN_TARGETS[$i]}"
  done
}

# ---- install steps ----------------------------------------------------------
install_packages() {
  local pkg missing=()
  for pkg in "${PKGS[@]}"; do
    dpkg -s "$pkg" 2>/dev/null | grep -q '^Status: install ok installed' || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    log "All packages are already installed."
    return 0
  fi
  log "Installing packages: ${missing[*]}"
  run sudo env DEBIAN_FRONTEND=noninteractive apt-get update </dev/null
  run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_OPTS[@]}" "${missing[@]}" </dev/null
}

install_font() {
  local url="https://github.com/ryanoasis/nerd-fonts/releases/download/${FONT_VERSION}/${FONT_ARCHIVE}" dest="${FONT_DEST/#\~/$HOME}"
  [ -n "$FONT_URL_OVERRIDE" ] && url="$FONT_URL_OVERRIDE"
  if [ "$DRY_RUN" = true ]; then
    if curl -fsIL --max-time 20 -o /dev/null "$url" 2>/dev/null; then
      printf '[dry-run] download %s\n' "$url"
      printf '[dry-run] verify sha256 %s\n' "$FONT_SHA"
      printf '[dry-run] extract to %s and run fc-cache\n' "$dest"
    else
      printf '[dry-run] could not reach %s: the install would fall back to %s\n' "$url" "$FONT_FALLBACK"
    fi
    return 0
  fi
  if ! curl -fsSL --max-time 600 -o "$WORK/font.tar.xz" "$url"; then
    warn "could not download $FONT_NAME. Installing $FONT_FALLBACK instead."
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_OPTS[@]}" "$FONT_FALLBACK" </dev/null
    return 0
  fi
  local actual
  actual="$(sha256sum "$WORK/font.tar.xz" | cut -d' ' -f1)"
  [ "$actual" = "$FONT_SHA" ] || die "checksum mismatch for the font archive (expected $FONT_SHA, got $actual). Nothing was installed from it."
  mkdir -p "$dest"
  tar -xJf "$WORK/font.tar.xz" -C "$dest"
  fc-cache -f "$HOME/.local/share/fonts" >/dev/null
  log "Installed $FONT_NAME to $dest"
}

write_files() {
  local i target
  log "Writing config files"
  for i in "${!PLAN_TARGETS[@]}"; do
    target="${PLAN_TARGETS[$i]/#\~/$HOME}"
    install_file "$target" "$WORK/out/$i"
  done
}

# Start method: manual changes nothing. tty1 appends a marked block to ~/.profile. greetd writes its config under /etc.
configure_start() {
  case "${CODE[start]}" in
    manual) ;;
    tty1) configure_tty1 ;;
    greetd) configure_greetd ;;
    *) die "unknown start method ${CODE[start]}." ;;
  esac
}

configure_tty1() {
  local profile="$HOME/.profile" new="$WORK/profile"
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] add a marked block to %s that starts sway on tty1\n' "$profile"
    return 0
  fi
  backup_existing "$profile"
  {
    if [ -f "$profile" ]; then
      sed '/^# BEGIN deskwizard$/,/^# END deskwizard$/d' "$profile"
    fi
    cat <<'BLOCK'
# BEGIN deskwizard
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(tty)" = /dev/tty1 ]; then
  exec sway
fi
# END deskwizard
BLOCK
  } > "$new"
  install -m 0644 "$new" "$profile"
  log "added the tty1 block to $profile"
}

configure_greetd() {
  local conf="$WORK/greetd.toml"
  cat > "$conf" <<'TOML'
# Written by deskwizard. Remove this file, or restore the backup, to undo.
[terminal]
vt = 1

[default_session]
command = "tuigreet --time --sessions /usr/share/wayland-sessions"
user = "_greetd"
TOML
  install_file /etc/greetd/config.toml "$conf" sudo
  run sudo systemctl enable greetd.service
}

finish() {
  printf '\n'
  if [ "$DRY_RUN" = true ]; then
    log "Dry run complete. Nothing was changed."
  else
    log "Installation complete. Old configs were saved to $BACKUP_DIR"
  fi
  if [ -n "$CHEATSHEET" ]; then
    printf 'Keys:\n%s\n' "$CHEATSHEET"
  fi
  printf '==================================================\n'
  case "${CODE[start]}" in
    manual) printf ' START: log in on this console, then run:  sway\n' ;;
    tty1)   printf ' START: log in on the first console (Ctrl+Alt+F1).\n        Sway starts by itself.\n' ;;
    greetd) printf ' START: reboot. The login screen starts Sway.\n' ;;
  esac
  printf ' IF IT FAILS: press Ctrl+Alt+F2 to get a shell.\n'
  printf '==================================================\n'
}

# ---- main -------------------------------------------------------------------
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

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --build)
        [ "$#" -ge 2 ] || die "--build needs a build code."
        BUILD_CODE="$2"
        shift 2
        ;;
      --dry-run) DRY_RUN=true; shift ;;
      -h|--help)
        printf 'Usage: bash install.sh --build <code> [--dry-run]\n'
        exit 0
        ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$BUILD_CODE" ] || die "missing --build <code>. Copy the install command from the wizard's Review step."
  if [ "$DRY_RUN" = true ]; then
    log "DRY RUN: nothing will be changed"
  fi
  curl -fsSL --retry 2 -o "$WORK/manifest.json" "$SITE_BASE/manifest.json" \
    || die "could not download manifest.json from $SITE_BASE. Nothing was changed."
  # Input checks come first: a bad code or unknown id is rejected before anything else runs.
  parse_code "$BUILD_CODE"
  check_ids
  check_user
  check_os
  fetch_data
  build_plan
  show_plan
  install_packages
  if [ "$FONT_DL" = true ]; then
    install_font
  fi
  write_files
  configure_start
  finish
}

main "$@"
