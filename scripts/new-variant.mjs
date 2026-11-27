#!/usr/bin/env node
// Creates catalog/tools/<tool>/variants/<NN>/ by copying the first existing variant of that tool,
// then sets the new id and name in meta.yaml and runs the validator.
// Copied files are placeholders: edit the config, pick good_for and replace the screenshot before you open a PR.
// If validation fails, the new folder is removed again.
// Run: npm run new-variant -- <tool> <id>
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, rel } from "./lib/load.mjs";
import { ID_RE, titleFromId, runValidate } from "./lib/scaffold.mjs";

const [tool, id] = process.argv.slice(2);
if (!tool || !id || !ID_RE.test(id)) {
  console.error("usage: npm run new-variant -- <tool> <id>   (id: lowercase letters, digits and dashes, starting with a letter)");
  process.exit(2);
}

const toolDir = join(CATALOG, "tools", tool);
if (!existsSync(join(toolDir, "tool.yaml"))) {
  console.error(`new-variant: no tool '${tool}' (expected ${rel(join(toolDir, "tool.yaml"))}). Run npm run new-tool first.`);
  process.exit(2);
}

const variantsDir = join(toolDir, "variants");
const dirs = existsSync(variantsDir)
  ? readdirSync(variantsDir).filter((n) => statSync(join(variantsDir, n)).isDirectory()).sort()
  : [];

for (const d of dirs) {
  const meta = readFileSync(join(variantsDir, d, "meta.yaml"), "utf8");
  if (new RegExp(`^id: ${id}$`, "m").test(meta)) {
    console.error(`new-variant: ${tool} already has a variant with id '${id}' in variants/${d}.`);
    process.exit(2);
  }
}

if (dirs.length === 0) {
  console.error(`new-variant: ${tool} has no variant to copy. Create variants/01/ by hand, then re-run validation.`);
  process.exit(2);
}

const nextNum = String(Math.max(...dirs.map((d) => Number(d)).filter((n) => Number.isInteger(n))) + 1).padStart(2, "0");
const source = join(variantsDir, dirs[0]);
const target = join(variantsDir, nextNum);
if (existsSync(target)) {
  console.error(`new-variant: ${rel(target)} already exists.`);
  process.exit(2);
}

mkdirSync(target, { recursive: true });
for (const name of readdirSync(source)) {
  if (name === "meta.yaml") continue;
  cpSync(join(source, name), join(target, name), { recursive: true });
}

const sourceMeta = readFileSync(join(source, "meta.yaml"), "utf8");
const meta = `# New variant. Review good_for and replace the placeholder screenshot before opening a PR.\n` +
  sourceMeta
    .replace(/^id: .*$/m, `id: ${id}`)
    .replace(/^name: .*$/m, `name: ${titleFromId(id)}`);
writeFileSync(join(target, "meta.yaml"), meta);

const result = runValidate();
if (!result.ok) {
  rmSync(target, { recursive: true, force: true });
  console.error(`new-variant: validation failed, removed ${rel(target)}:\n${result.output}`);
  process.exit(1);
}
console.log(`new-variant: created ${rel(target)} (copied from variants/${dirs[0]}) and validation passes.`);
console.log("Next: edit the config files, set good_for, and replace the placeholder screenshot.");
