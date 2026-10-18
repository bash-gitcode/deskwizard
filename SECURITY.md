# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub security advisories:
<https://github.com/bash-gitcode/deskwizard/security/advisories/new>

Include the steps to reproduce, the affected file or version, and what you think the impact is.
We aim to acknowledge a report within 7 days. We will tell you when a fix is released and credit you if you want.

## What is in scope

- `site/src/installer.sh` and the generated `v1/install.sh`: anything that lets the installer run code, write files,
  or change system state outside what the wizard shows on the Review page.
- `site/src/uninstall.sh`: removing or restoring files it should not touch.
- `v1/manifest.json` and the sha256 checks: any way to make the installer accept a file that does not match its checksum.
- The build code parser (`site/src/generator.js` and the data files it reads): input that makes generated shell code run something unintended.
- The supply chain: GitHub Actions workflows, pinned action SHAs, the release process, and the npm dependencies used at build time.

## Out of scope

- Packages from Debian itself. Report those to Debian.
- Nerd Fonts and other upstream projects. Report those to their maintainers.
- Problems that need a user to run a command they have not read. The one-liner is documented as "read it first".
