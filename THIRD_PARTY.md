# Third-party software and content

deskwizard does not redistribute any third-party file. The catalog, wallpapers, palettes, screenshots and
installer code in this repository were written for this project and are covered by the MIT license in `LICENSE`.

## Downloaded at install time (not redistributed)

| Item | Where it comes from | Licence | Notes |
| --- | --- | --- | --- |
| Nerd Fonts, JetBrainsMono and the other fonts in `catalog/fonts.yaml` | github.com/ryanoasis/nerd-fonts, release v3.5.1 | SIL Open Font License 1.1 for the font files. Nerd Fonts also bundles upstream icon sets that carry their own licences (see the Nerd Fonts repository). | The installer downloads the archive and checks its sha256 against the value pinned in `catalog/fonts.yaml`. The archive is not stored in this repository. |

## Installed from Debian 13 (trixie) apt packages

The installer runs `apt-get install` for the packages listed under `packages.debian13` in each
`catalog/tools/*/tool.yaml`, plus their dependencies. These packages are not copied into this repository.
Their licences are the ones in Debian's package metadata (`/usr/share/doc/<pkg>/copyright` on an installed system).

The authoritative list is generated from the catalog: run `node scripts/ci-helpers.mjs packages` in a checkout.
CI checks that every package has a candidate in Debian 13 on every pull request (`package-check` job).
