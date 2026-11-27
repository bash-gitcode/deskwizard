# Releasing (maintainers)

## Rules

- A tag `vX.Y.Z` is the only way to publish. The release workflow (`.github/workflows/release.yml`) builds from the tag and attaches the files.
- Each tag gets an immutable folder `/vX.Y.Z/` on the site, built from the tag. Its installer reads only from that folder. `/v1/` is the latest compatible folder and is rebuilt from `main` on each deploy, so it can change.
- Pre-release tags (`vX.Y.Z-rcN`) are published as GitHub pre-releases. The wizard points at the latest non-pre-release tag.
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
6. Wait for the `release` workflow to finish. It runs the smoke test, rebuilds the snapshot for the tag, checks the sha256 files and creates the GitHub Release with:
   `install.sh`, `install.sh.sha256`, `uninstall.sh`, `uninstall.sh.sha256`, `manifest.json`, `manifest.json.sha256` and `snapshot-<tag>.tar.gz` (the folder that `pages.yml` restores on every later deploy). It then starts `pages.yml`, which publishes `/<tag>/`.
7. Check the release page: download the files and run `sha256sum -c` against the `.sha256` files.
8. Confirm the published site's install command still matches the release.

## Verifying a download (for users)

```sh
curl -fsSLO https://github.com/bash-gitcode/deskwizard/releases/download/v0.1.0/install.sh
curl -fsSLO https://github.com/bash-gitcode/deskwizard/releases/download/v0.1.0/install.sh.sha256
sha256sum -c install.sh.sha256
```
