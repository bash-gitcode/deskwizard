// Sets the installer's SITE_BASE to the folder it is published in (v1, or a release tag such as v0.1.0).
// The installer then fetches manifest.json and files/ from that same folder, so the script and its data always match.
export const SITE_ROOT = "https://bash-gitcode.github.io/deskwizard";

const BASE_LINE = /^SITE_BASE="https:\/\/bash-gitcode\.github\.io\/deskwizard\/[^"]*"$/gm;

export function renderInstaller(src, dir) {
  const matches = src.match(BASE_LINE) || [];
  if (matches.length !== 1) {
    throw new Error(`installer.sh must contain exactly one SITE_BASE line, found ${matches.length}`);
  }
  return src.replace(BASE_LINE, `SITE_BASE="${SITE_ROOT}/${dir}"`);
}
