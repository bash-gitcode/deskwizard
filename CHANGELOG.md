# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/). `/v1/` of the installer is frozen after v0.1.0 (see README).

## [0.1.0] - unreleased (set the date when the tag is cut)

First public release. Phase 1 scope only.

### Added

- Static wizard (no backend) that builds a Debian 13 + Sway setup and shows one install command.
- Installer with sha256 checks on every shipped data file, a `--dry-run` mode, and `uninstall.sh` that restores the latest backups.
- Tools: sway, waybar (5 variants), foot, fuzzel, mako, swaybg (3 wallpapers).
- Palettes and fonts catalogs; the Nerd Font is downloaded at install time, pinned by sha256.
- CI: catalog validation, reference and manifest checks, apt candidate check for every package, shellcheck, headless Sway smoke test, browser click-through, first-run check in `debian:trixie`.
- Release workflow that attaches `install.sh`, `uninstall.sh`, `manifest.json` and their `.sha256` files to a tagged GitHub Release.
- `npm run new-tool` and `npm run new-variant` scaffolds that run the validator.
