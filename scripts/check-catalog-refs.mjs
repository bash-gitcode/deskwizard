#!/usr/bin/env node
// Fails if a file under catalog/tools/ is not referenced by a tool.yaml or a variant meta.yaml.
// A file counts as referenced when it is:
//   - a tool.yaml or meta.yaml itself
//   - an install source of a tool (from: tool -> tools/<id>/files/<source>)
//   - an install source of a variant (from: variant -> tools/<id>/variants/<NN>/<source>)
//   - the screenshot of a variant
//   - the SVG source of a PNG that is referenced (wallpaper.svg -> wallpaper.png, rendered by render-wallpapers)
// Top-level config (catalog/schema, distros.yaml, fonts.yaml) is checked by validate.mjs, not here.
// Run: npm run check-catalog-refs
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CATALOG, readYaml, rel } from "./lib/load.mjs";

const toolsDir = join(CATALOG, "tools");
const errors = [];
const referenced = new Set();
const ref = (path) => referenced.add(path);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function dirs(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((n) => statSync(join(path, n)).isDirectory()).sort();
}

for (const id of dirs(toolsDir)) {
  const toolDir = join(toolsDir, id);
  const toolYaml = join(toolDir, "tool.yaml");
  if (!existsSync(toolYaml)) {
    errors.push(`${rel(toolDir)}: tool folder has no tool.yaml`);
    continue;
  }
  ref(toolYaml);
  let tool;
  try {
    tool = readYaml(toolYaml);
  } catch (e) {
    errors.push(`${rel(toolYaml)}: cannot parse YAML (${e.message})`);
    continue;
  }
  for (const item of tool.install ?? []) {
    if (item.from === "tool") ref(join(toolDir, "files", item.source));
  }
  for (const v of dirs(join(toolDir, "variants"))) {
    const vDir = join(toolDir, "variants", v);
    const metaPath = join(vDir, "meta.yaml");
    if (!existsSync(metaPath)) {
      errors.push(`${rel(vDir)}: variant folder has no meta.yaml`);
      continue;
    }
    ref(metaPath);
    let meta;
    try {
      meta = readYaml(metaPath);
    } catch (e) {
      errors.push(`${rel(metaPath)}: cannot parse YAML (${e.message})`);
      continue;
    }
    if (meta.screenshot) ref(join(vDir, meta.screenshot));
    for (const item of tool.install ?? []) {
      if (item.from === "variant") ref(join(vDir, item.source));
    }
  }
}

// A rendered PNG keeps its SVG source referenced.
for (const p of [...referenced]) {
  if (p.endsWith(".png")) {
    const svg = p.replace(/\.png$/, ".svg");
    if (existsSync(svg)) ref(svg);
  }
}

for (const file of walk(toolsDir)) {
  if (!referenced.has(file)) {
    errors.push(`${rel(file)}: not referenced by any tool.yaml or variant meta.yaml. Remove it or reference it.`);
  }
}

// Reference targets that do not exist are reported too, so a typo in a source name fails here.
for (const p of referenced) {
  if (!existsSync(p) && !p.endsWith(".png")) {
    errors.push(`${relative(CATALOG, p)}: referenced but missing`);
  }
}

if (errors.length) {
  console.error("check-catalog-refs: FAIL");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-catalog-refs: PASS (${referenced.size} referenced files, every tools/ file covered)`);
