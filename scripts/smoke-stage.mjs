#!/usr/bin/env node
// Staging helper for the tool smoke test and the screenshot scenes. Reads site/public/catalog.json (run build-catalog first).
//   node scripts/smoke-stage.mjs list                         "tool variant" per line, every variant of the smoke tools
//   node scripts/smoke-stage.mjs stage <tool> <variant> <dir>  writes the files the installer would write for that tool
//                                                             under <dir>, with palette tokens resolved. Sway's own
//                                                             files are left out: the smoke test starts its own Sway.
//   node scripts/smoke-stage.mjs scene <dir> <base|-> [tool variant]
//                                                             the files for a screenshot scene: a base (or "-" for the
//                                                             default choices), with one tool variant swapped in.
//   node scripts/smoke-stage.mjs shot-list                    "base <id>" per base, then "variant <tool> <variant>" per variant
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

// Writes the plan's files under dir, leaving out the Sway files (the caller runs its own Sway).
function writeFiles(plan, dir, skipTargets) {
  for (const f of plan.files) {
    if (skipTargets.has(f.target)) continue;
    const dest = join(dir, f.target.replace(/^~\//, ""));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.binary ? Buffer.from(f.content, "base64") : f.content);
    console.log(f.target);
  }
}

function swayTargets() {
  const swayOnly = buildPlan(stateFor({ sway: { variant: null } }), catalog);
  if (!swayOnly.ok) fail(swayOnly.errors.join("; "));
  return new Set(swayOnly.plan.files.map((f) => f.target));
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  for (const tool of catalog.tools) {
    if (!SMOKE_TOOLS.includes(tool.id)) continue;
    for (const variant of tool.variants) console.log(`${tool.id} ${variant.id}`);
  }
} else if (cmd === "shot-list") {
  for (const base of catalog.bases ?? []) console.log(`base ${base.id}`);
  for (const tool of catalog.tools) {
    if (!SMOKE_TOOLS.includes(tool.id)) continue;
    for (const variant of tool.variants) console.log(`variant ${tool.id} ${variant.id}`);
  }
} else if (cmd === "stage") {
  const [toolId, variantId, dir] = args;
  if (!toolId || !variantId || !dir) fail("usage: stage <tool> <variant> <dir>");
  const result = buildPlan(stateFor({ sway: { variant: null }, [toolId]: { variant: variantId } }), catalog);
  if (!result.ok) fail(result.errors.join("; "));
  writeFiles(result.plan, dir, swayTargets());
} else if (cmd === "scene") {
  const [dir, baseArg, toolId, variantId] = args;
  if (!dir || !baseArg) fail("usage: scene <dir> <base|-> [tool variant]");
  const base = baseArg === "-" ? null : (catalog.bases ?? []).find((b) => b.id === baseArg);
  if (baseArg !== "-" && !base) fail(`no base with id '${baseArg}'`);
  // A base carries every tool choice; without one, every smoke tool uses its default variant.
  const choices = base
    ? structuredClone(base.tools)
    : Object.fromEntries([["sway", { variant: null }], ...SMOKE_TOOLS.map((id) => [id, { variant: catalog.tools.find((t) => t.id === id).default_variant }])]);
  if (toolId) choices[toolId] = { variant: variantId };
  const state = {
    distro: distro.id,
    display: "wayland",
    font: base?.font ?? catalog.fonts.default,
    palette: base?.palette ?? DEFAULT_PALETTE,
    start: base?.start,
    extras: [],
    choices,
    options: base?.options ?? {},
  };
  const result = buildPlan(state, catalog);
  if (!result.ok) fail(result.errors.join("; "));
  writeFiles(result.plan, dir, swayTargets());
} else {
  fail("usage: smoke-stage.mjs list | shot-list | stage <tool> <variant> <dir> | scene <dir> <base|-> [tool variant]");
}
