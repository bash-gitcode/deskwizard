#!/usr/bin/env node
// Renders a deskwizard install script from a build state, using the same generator the site uses.
// Usage:
//   node scripts/generate-install.mjs                 default build (Sway + Waybar minimal), writes site/public/install.sh
//   node scripts/generate-install.mjs build.yaml out.sh   build from a Save/Load file
// Requires site/public/catalog.json (run build-catalog first).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildPlan, renderScript, fromPayload } from "../site/src/generator.js";
import { ROOT } from "./lib/load.mjs";

const DEFAULT_STATE = {
  distro: "debian13",
  display: "wayland",
  font: "jetbrains-mono",
  choices: {
    sway: { variant: null },
    waybar: { variant: "minimal" },
  },
};

const [, , inputArg, outArg] = process.argv;
// Default: the versioned installer at /v1/install.sh, plus /install.sh as an alias to the latest version.
const PUBLIC = join(ROOT, "site", "public");
const outPaths = outArg ? [outArg] : [join(PUBLIC, "v1", "install.sh"), join(PUBLIC, "install.sh")];
const catalog = JSON.parse(readFileSync(join(ROOT, "site", "public", "catalog.json"), "utf8"));
const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "site", "src", "installer.template.sh"), "utf8");

const state = inputArg
  ? fromPayload(parse(readFileSync(inputArg, "utf8")), catalog.catalog_version).state
  : DEFAULT_STATE;
const { ok, errors, plan } = buildPlan(state, catalog);
if (!ok) {
  console.error("generate-install: cannot build a script from this state:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

const script = renderScript(plan, catalog.fonts, template);
for (const outPath of outPaths) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, script, { mode: 0o755 });
  console.log(`generate-install: wrote ${outPath} (${plan.packages.length} packages, ${plan.files.length} files, font: ${plan.font.name})`);
}
