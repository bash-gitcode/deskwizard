# deskwizard

deskwizard is a free, static web wizard that builds a Linux desktop setup for Debian 13 "trixie" with Sway,
then gives you one install command for it. There is no backend, no account and no analytics. The build lives in
your browser tab and in the share link. MIT licensed.

<!-- Screenshot: docs/wizard.png, one frame of the Review step captured by the wizard-e2e CI job (run 39102843063,
     artifact wizard-e2e-screenshots). It is not taken from the Pages deploy. See CONTRIBUTING.md. -->
![The deskwizard wizard, Review step](docs/wizard.png)

## Read this first

The install command runs a shell script as your user, and the script uses `sudo` to install packages. **Read the
script before you run it.** The steps below download it, check its checksum and show it to you.

## Install (read first, then run)

The wizard's Review page shows the exact command, including the build code (`--build <code>`).

```sh
# 1. Download the installer
curl -fsSLO https://bash-gitcode.github.io/deskwizard/v1/install.sh
curl -fsSLO https://bash-gitcode.github.io/deskwizard/v1/install.sh.sha256

# 2. Check it against the checksum published with the release
sha256sum -c install.sh.sha256        # must print: install.sh: OK

# 3. Read it
less install.sh

# 4. Run it with the build code from the wizard
bash install.sh --build <code> --dry-run   # shows every change without making it
bash install.sh --build <code>
```

The checksum on the wizard's Review page must equal the output of `sha256sum install.sh`.
If it does not, stop and open an issue.

### Versions

Each release tag `vX.Y.Z` has its own folder on the site, for example `https://bash-gitcode.github.io/deskwizard/v0.1.0/`.
That folder holds the installer and the data it reads, and its installer reads only from that folder. Once published, the
folder is never overwritten. The wizard's Review page shows the one-liner for the latest stable tag.

`/v1/` is the **latest compatible** folder. It is rebuilt from `main` on each deploy, so it can change. For a fixed
version, use `/vX.Y.Z/` or the files on the [releases page](https://github.com/bash-gitcode/deskwizard/releases), which
lists `install.sh`, `uninstall.sh`, `manifest.json` and their `.sha256` files for each tag. See [RELEASING.md](RELEASING.md).

## Trust

**What the installer does:**

- Checks that it runs as your normal user and that `/etc/os-release` says Debian 13.
- Downloads `manifest.json` and the data files from its own folder, and checks each one against its sha256 before it
  uses it. A mismatch stops the run before anything changes.
- Installs the packages it lists with `sudo apt-get`, from Debian's archive.
- Downloads the Nerd Font from its official release, and checks it against a pinned sha256. If the download fails, it
  installs `fonts-font-awesome` from Debian instead.
- Writes the config files the wizard shows on the Review page. Before it replaces a file, it copies the old one to
  `~/.config-backup/<timestamp>/`.
- With the tty1 start method, appends a block between `# BEGIN deskwizard` and `# END deskwizard` to `~/.profile`.
  With the greetd start method, writes `/etc/greetd/config.toml` and enables `greetd.service` with `sudo`.

**What it does not do:** it does not run a script it downloaded from elsewhere, does not send data anywhere (no analytics,
no accounts), and does not install anything that the Review page did not list. The build code is data: it is parsed,
never executed.

**How to verify before you run it:**

1. Check the sha256 of `install.sh` against the value on the Review page, or the `.sha256` file on the release.
2. Read it: `less install.sh`.
3. Run `bash install.sh --build <code> --dry-run`. It prints every step and changes nothing.

**Files it writes:** the Review page lists the exact targets for your build. They are under `~/.config/`,
`~/.local/share/backgrounds/deskwizard/`, `~/.profile` (tty1 only), `/etc/greetd/config.toml` (greetd only) and
`~/.config-backup/`. `uninstall.sh` restores the backups.

**This project is early.** It supports Debian 13 with Sway only. We recommend trying it in a virtual machine first
(see below).

## Supported scope

- **Distribution:** Debian 13 "trixie" only.
- **Desktop:** Sway (Wayland). Waybar is the bar.
- **Tools in this release:** sway, waybar (5 looks), foot, fuzzel, mako, swaybg (3 wallpapers).
- **Font:** a Nerd Font is downloaded at install time from its official release, pinned by sha256 (not redistributed here).

Packages are installed from Debian's archive. CI checks that each one has a candidate in Debian 13 on every pull request.

## Known limits

- Debian 13 only. The installer reads `/etc/os-release` and stops on other systems.
- The installer changes system configuration that Sway needs, and replaces some user config files. It backs up what it
  replaces, and `uninstall.sh` restores the latest backups. Review the Review page before you run it.
- Headless smoke tests check that each variant starts on Sway and is screenshotted. They do not check how it looks on your hardware.
- CI starts every Waybar, foot, fuzzel, mako and swaybg variant under headless Sway. That is a start-up check, not a visual review.
- The site is static. Your build is not stored anywhere else; the share link carries it.

## Uninstall

```sh
curl -fsSLO https://bash-gitcode.github.io/deskwizard/v1/uninstall.sh
bash uninstall.sh --dry-run    # shows what it would restore
bash uninstall.sh
```

It restores the latest backups of the files the installer replaced. It does not remove packages that were installed
through apt; remove those with `sudo apt remove <package>` if you want them gone.

## Test in a virtual machine

Install Debian 13 in a VM (for example with QEMU or VirtualBox) from a clean image, sign in as a normal user with sudo,
then follow the install steps above. Take a snapshot before you run `install.sh` so you can roll back.

To test the installer without changing anything, run the dry run from a checkout:

```sh
npm ci && npm run build
bash site/public/v1/install.sh --build <code> --dry-run
```

## Development

```sh
npm ci                 # also renders the wallpapers (prepare script)
npm run validate       # schemas and cross-references
npm run build          # everything, then the Vite bundle into dist/
npm run dev            # local preview
```

- [CONTRIBUTING.md](CONTRIBUTING.md): add a tool or a variant in about 5 minutes, and how CI checks it.
- [SECURITY.md](SECURITY.md): report a vulnerability privately.
- [CHANGELOG.md](CHANGELOG.md) and [RELEASING.md](RELEASING.md).
- [THIRD_PARTY.md](THIRD_PARTY.md): what is not authored here (Nerd Fonts, Debian packages).

## Layout

```
catalog/                 tools, variants, palettes, fonts, schemas (the source of truth)
scripts/                 validate, build-catalog, generate-install, checks, scaffolds
site/src/                wizard (vanilla JS), installer.sh, uninstall.sh
site/public/v1/          generated installer, manifest and data files (build output, not committed)
tests/                   unit tests (node --test tests/) and the browser click-through
```

## Licence

MIT. See [LICENSE](LICENSE).
