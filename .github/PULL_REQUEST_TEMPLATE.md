## What does this change?

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm ci && npm run validate` passes locally.
- [ ] CI is green on this PR (`ci`, including `first-run`, `package-check`, `tool-smoke`, `full-install`, `uninstall`, `font-check`, `start-methods` and `wizard-e2e`).
- [ ] Screenshot checked: for a new or changed variant, I looked at the PNG from `smoke-out/` (or the `tool-smoke` artifact) and it shows the intended look.
- [ ] Packages verified in `debian:trixie`: every new package name has an apt candidate (`apt-cache policy <name>`).
- [ ] Licence note: I wrote every new file myself, or I state below where each third-party file comes from and its licence. No palette is copied from a named theme.
- [ ] `CHANGELOG.md` updated under "Unreleased", if the change is user-visible.

## Licence note

<!-- "All new files are original." or list each third-party file, its source and its licence. -->
