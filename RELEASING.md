# Releasing (maintainers)

## Rules

- A tag `vX.Y.Z` is the only way to publish. The release workflow (`.github/workflows/release.yml`) builds from the tag and attaches the files.
- `/v1/` of the installer is frozen after the first tag. Changes that alter what an existing `/v1/install.sh` does ship as `/v2/`, or as a new minor tag that keeps `/v1/` unchanged. Never edit an installed `/v1/` file in place.
- Do not merge a release PR unless CI is green on the commit that will be tagged.

## Steps

1. Update `CHANGELOG.md`: move "Unreleased" items under the new version, with the date.
2. Make sure `package.json` `version` matches the tag (without the `v`).
3. Open a PR, get the CODEOWNERS review, merge when CI is green (the `ci` workflow).
4. On the merged commit, check the build locally or in CI:
   ```sh
   npm ci && npm run build && npm run -s check-manifest
   ```
5. Tag and push:
   ```sh
   git tag -a v0.1.0 -m "deskwizard v0.1.0"
   git push origin v0.1.0
   ```
6. Wait for the `release` workflow to finish. It runs the smoke test, rebuilds, checks the sha256 files and creates the GitHub Release with:
   `install.sh`, `install.sh.sha256`, `uninstall.sh`, `uninstall.sh.sha256`, `manifest.json`, `manifest.json.sha256`.
7. Check the release page: download the files and run `sha256sum -c` against the `.sha256` files.
8. Confirm the published site's install command still matches the release.

## Verifying a download (for users)

```sh
curl -fsSLO https://github.com/bash-gitcode/deskwizard/releases/download/v0.1.0/install.sh
curl -fsSLO https://github.com/bash-gitcode/deskwizard/releases/download/v0.1.0/install.sh.sha256
sha256sum -c install.sh.sha256
```
