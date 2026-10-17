#!/usr/bin/env node
// Staging helper for the tool smoke test. Reads site/public/catalog.json (run build-catalog first).
//   node scripts/smoke-stage.mjs list                         "tool variant" per line, every variant of the smoke tools
//   node scripts/smoke-stage.mjs stage <tool> <variant> <dir>  writes the files the installer would write for that tool
//                                                             under <dir>, with palette tokens resolved. Sway's own
//                                                             files are left out: the smoke test starts its own Sway.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT } from "./lib/load.mjs";
import { buildPlan, DEFAULT_PALETTE } from "../site/src/generator.js";

export const SMOKE_TOOLS = ["waybar", "foot", "fuzzel", "mako", "swaybg"];

const catalog = JSON.parse(readFileSync(join(ROOT, "site", "public", "catalog.json"), "utf8"));
const distro = catalog.distros.find((d) => d.status === "available");

function stateFor(choices) {
  return { distro: distro.id, display: "wayland", font: catalog.fonts.default, palette: DEFAULT_PALETTE, extras: [], choices };
}

function fail(message) {
  console.error(`smoke-stage: ${message}`);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  for (const tool of catalog.tools) {
    if (!SMOKE_TOOLS.includes(tool.id)) continue;
    for (const variant of tool.variants) console.log(`${tool.id} ${variant.id}`);
  }
} else if (cmd === "stage") {
  const [toolId, variantId, dir] = args;
  if (!toolId || !variantId || !dir) fail("usage: stage <tool> <variant> <dir>");
  const swayOnly = buildPlan(stateFor({ sway: { variant: null } }), catalog);
  if (!swayOnly.ok) fail(swayOnly.errors.join("; "));
  const swayTargets = new Set(swayOnly.plan.files.map((f) => f.target));

  const result = buildPlan(stateFor({ sway: { variant: null }, [toolId]: { variant: variantId } }), catalog);
  if (!result.ok) fail(result.errors.join("; "));
  for (const f of result.plan.files) {
    if (swayTargets.has(f.target)) continue;
    const dest = join(dir, f.target.replace(/^~\//, ""));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.binary ? Buffer.from(f.content, "base64") : f.content);
    console.log(f.target);
  }
} else {
  fail("usage: smoke-stage.mjs list | stage <tool> <variant> <dir>");
}
