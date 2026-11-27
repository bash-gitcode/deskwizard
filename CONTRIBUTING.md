# Contributing

Thanks for helping. The most useful contributions are new variants (looks) and new tools. Both are data: you add
folders and YAML, and the wizard picks them up without UI code.

## Setup (3 commands)

```sh
git clone https://github.com/bash-gitcode/deskwizard.git && cd deskwizard
npm ci
npm run validate
```

`npm ci` renders the wallpaper PNGs from their SVG sources (the `prepare` script). `npm run validate` must print `validate: OK`.

## Add a variant (about 5 minutes)

```sh
npm run new-variant -- waybar my-look
```

This copies the first existing variant of the tool into the next free `variants/NN/` folder, sets the new `id` and `name`,
and runs the validator. If validation fails, the folder is removed again.

Then, in the new folder:

1. Edit `config.jsonc` and `style.css`. Colours must be `@define-color` names, not literal values in the rules.
2. Set `good_for` in `meta.yaml`.
3. Replace the placeholder `screenshot.svg` with a real screenshot of the variant running on Sway (see "Preview" below).
4. Only use options that exist in the Debian 13 versions of the tool (see the version table in the README).
5. Run `npm run validate` again. Run `npm run build` to check the whole site.

## Add a tool (about 5 minutes)

```sh
npm run new-tool -- my-tool
```

This writes `catalog/tools/my-tool/tool.yaml` with valid placeholder values and runs the validator. Replace every `TODO`.
Then:

1. Confirm the Debian 13 package name: `apt-get update && apt-cache policy <name>` in a `debian:trixie` container.
2. Put files the tool installs as-is under `files/`, or in variants (`from: variant`).
3. Set `requires` and `works_with` for other tools. The wizard shows "Also needs" automatically.
4. A `bar` or `wallpaper` tool needs at least one variant: add one with `npm run new-variant -- my-tool 01`.
   A new tool has no variants until you add one. `new-variant` needs an existing variant to copy, so for the first variant
   create `variants/01/` by hand, following the files of a similar tool.

## What CI checks

Every pull request runs:

- `validate`: schemas and cross-references (tools, variants, screenshots, install sources).
- `check-catalog-refs`: every file under `catalog/tools/` is referenced by a `tool.yaml` or a variant `meta.yaml`.
- `check-manifest`: the built installer and manifest match the files on disk.
- `package-check`: every package has an apt candidate in Debian 13, and shellcheck passes on the installer scripts.
- `first-run`: a fresh clone of the commit, then `npm ci` and `npm run validate`, in `debian:trixie`.
- `smoke`: every Waybar, foot, fuzzel, mako and swaybg variant starts on headless Sway and is screenshotted.
- `wizard-e2e`: the browser click-through.

## Preview a variant in a container

Needs Docker or Podman. Run as a non-root user:

```sh
docker run --rm -v "$PWD":/work -w /work debian:trixie bash -c '
  apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates curl xz-utils procps sway waybar grim fonts-font-awesome fontconfig &&
  useradd -m builder && chown -R builder /work &&
  runuser -u builder -- env HOME=/home/builder PATH="$PATH" bash -c "npm ci && node scripts/validate.mjs && node scripts/build-catalog.mjs && OUT=/work/smoke-out bash scripts/smoke-tools.sh"
'
```

Screenshots and logs land in `smoke-out/`. Open the PNG to check the look.

## Licensing of contributions

This project is MIT licensed (see `LICENSE`). By contributing you agree that your contribution is covered by the MIT license.

Do not add any of the following without saying so in the PR, and without a licence that allows redistribution in this repository:

- third-party artwork, wallpapers, icons or photos
- font files
- colour palettes copied from a named theme (for example a published colour scheme) — write your own names and values
- code copied from another project

If you are not sure whether something is allowed, ask in the issue before you open the PR.

## Pull request checklist

The PR template has the full list. In short: CI green, screenshot checked, packages verified in `debian:trixie`,
and a licence note for anything that is not written from scratch.
