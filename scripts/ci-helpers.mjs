#!/usr/bin/env node
// Helpers for CI and local smoke tests. Reads site/public/catalog.json (run build-catalog first).
//   node scripts/ci-helpers.mjs packages   one apt package per line: every package the catalog can
//                                          install on Debian 13, plus the bar extras and font fallbacks
//   node scripts/ci-helpers.mjs font      shell assignments for the default Nerd Font (for eval)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/load.mjs";
import { BAR_EXTRA_PACKAGES } from "../site/src/generator.js";

const catalog = JSON.parse(readFileSync(join(ROOT, "site", "public", "catalog.json"), "utf8"));
const [cmd] = process.argv.slice(2);

if (cmd === "packages") {
  const names = new Set();
  for (const tool of catalog.tools) {
    for (const pkg of tool.packages.debian13 ?? []) names.add(pkg);
  }
  for (const pkg of BAR_EXTRA_PACKAGES) names.add(pkg);
  for (const font of catalog.fonts.fonts) names.add(font.fallback_package);
  console.log([...names].sort().join("\n"));
} else if (cmd === "font") {
  const font = catalog.fonts.fonts.find((f) => f.id === catalog.fonts.default);
  if (!font) {
    console.error(`ci-helpers: default font '${catalog.fonts.default}' not found`);
    process.exit(1);
  }
  const q = (s) => `'${String(s ?? "").replaceAll("'", "'\\''")}'`;
  console.log(`NERD_FONT_NAME=${q(font.name)}`);
  console.log(`NERD_FONT_VERSION=${q(catalog.fonts.version)}`);
  console.log(`NERD_FONT_ARCHIVE=${q(font.archive)}`);
  console.log(`NERD_FONT_SHA256=${q(font.sha256)}`);
  console.log(`NERD_FONT_DEST=${q(font.dest)}`);
  console.log(`NERD_FONT_FAMILY=${q(font.family)}`);
} else {
  console.error("usage: node scripts/ci-helpers.mjs packages|font");
  process.exit(2);
}
