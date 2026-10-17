# deskwizard

A free, static site that builds a Linux desktop setup and gives you one install command.
No backend, no accounts, no analytics. Your build lives in the browser tab and in the share link. MIT licensed.

**Phase 1 scope:** Debian 13 "trixie" + Sway + Waybar only.

## Commands

```sh
npm ci
npm run validate        # checks every catalog YAML against the schemas
npm run build-catalog   # compiles catalog/ into site/public/catalog.json (+ screenshots)
npm run generate-install# writes site/public/install.sh for the default build
npm run dev             # local preview
npm run build           # all of the above, then the Vite bundle into dist/
```

Test the installer without changing anything (run as a normal user, not root):

```sh
npm run build
bash site/public/v1/install.sh --dry-run
```

The installer is served from `/v1/install.sh`. `/install.sh` at the site root is an alias to the latest version. The wizard's one-liner uses the versioned path.

## CI (`.github/workflows/ci.yml`)

Runs on push to `main`, on every pull request, and on manual dispatch.

- **Job A, `package-check`** (container `debian:trixie`): builds, checks that every apt package the catalog needs has a candidate in Debian 13 (`apt-cache policy`, fails on any missing one), runs the installer dry run as a non-root user, and runs `shellcheck -x` on the installer and `scripts/smoke-waybar.sh`.
- **Job B, `waybar-variants`** (container `debian:trixie`): installs Sway, Waybar 0.12.0, grim, Font Awesome, fontconfig and the pinned Nerd Font (checksum checked). It starts headless Sway (1920x1080, pixman) and runs each Waybar variant for 5 s. It fails if the process exits or stderr contains `error` or `failed`. It lists warnings separately and saves a `grim` screenshot per variant. Uploads the `waybar-smoke` artifact.
- **Job C, `wizard-e2e`** (Ubuntu runner): installs Playwright and headless Chromium in CI only (not a repo dependency). It clicks through Debian 13 > Wayland > Sway > Waybar > variant > Review, checks the badges, the one-liner (`/v1/install.sh`), Save/Load, and the old-catalog notice. Uploads the `wizard-e2e-screenshots` artifact, one screenshot per step.

### Run the Waybar smoke test locally in a container

Needs Docker or Podman. Run it as a non-root user inside the container:

```sh
docker run --rm -v "$PWD":/work -w /work debian:trixie bash -c '
  apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates curl xz-utils procps sway waybar grim fonts-font-awesome fontconfig &&
  useradd -m builder && chown -R builder /work &&
  runuser -u builder -- env HOME=/home/builder PATH="$PATH" bash -c "npm ci && node scripts/validate.mjs && node scripts/build-catalog.mjs && OUT=/work/smoke-out bash scripts/smoke-waybar.sh"
'
```

Screenshots and logs land in `smoke-out/`.

### Run the browser click-through locally

```sh
npm run build
npm i --no-save playwright@1.48.2 && npx playwright install --with-deps chromium
node tests/e2e/wizard.e2e.mjs      # screenshots go to e2e-shots/
```

Unit tests for the generator and the share-link payload: `node --test tests/`.

## Layout

```
catalog/
  distros.yaml            distros shown in step 1
  fonts.yaml              pinned Nerd Font release (URL, sha256)
  tools/<id>/tool.yaml    one file per tool; packages keyed by distro
  tools/<id>/files/       files a tool installs as-is (e.g. sway.conf)
  tools/<id>/variants/NN/ meta.yaml, config.jsonc, style.css, screenshot.svg
  schema/*.json           JSON Schemas used by validate
scripts/
  validate.mjs           schema + cross-reference checks
  build-catalog.mjs      catalog/ -> site/public/catalog.json
  generate-install.mjs   state -> install.sh (same generator as the site)
site/
  index.html, src/        vanilla JS wizard (no UI framework)
  src/generator.js        pure state -> plan -> script logic
  src/installer.template.sh  the bash template
```

## Add a variant in 5 minutes

1. Copy `catalog/tools/waybar/variants/01` to `variants/06` and change the `id` and `name` in `meta.yaml`.
2. Edit `config.jsonc` and `style.css`. Colours must be `@define-color` names, not literals (see the existing variants).
3. Only use Sway/Waybar options that exist in the Debian 13 versions (see the table below).
4. Replace `screenshot.svg` with a real screenshot, or keep the placeholder (update the `screenshot` field if the file type changes).
5. Run `npm run build`. It fails with the file and field that is wrong.

## Add a tool in 5 minutes

1. Create `catalog/tools/<id>/tool.yaml` with the required fields (copy `waybar/tool.yaml`).
2. Fill `packages.debian13` with names verified in a `debian:trixie` container (`apt-get update && apt-cache policy <pkg>`).
3. Put any files it installs under `files/` (for `from: tool`) or in variants (for `from: variant`).
4. Add `requires` / `works_with` if it depends on another tool. The wizard adds the "Also needs" prompt automatically.
5. Run `npm run build`. The wizard shows a page for the tool with no UI code changes.

## Versions shipped by Debian 13 (trixie)

Recorded from the trixie archive during Phase 1 (see the report for how they were checked).
Variants may only use options available in these versions.

| Package | Candidate (read from the host's apt lists, not refreshed; Job A checks in CI) |
|---|---|
| sway | 1.10.1-2 |
| waybar | 0.12.0-1 |
| swaylock | 1.8.2-1 |
| fonts-font-awesome | 5.0.10+really4.7.0~dfsg-4.1 |
| curl | 8.14.1-2+deb13u7 |
| fontconfig | 2.15.0-2.3 |

## Licence

MIT. See `LICENSE`.
