// Copies the scene images (scene-shots/*.webp, from scripts/shots/crop.py) into site/public/screenshots.
// Every image the catalog references (each base's image and each tool variant's screenshot) must exist and be
// non-empty, or the Pages build fails. Run build-catalog first.
//   node scripts/copy-screenshots.mjs [scene-shots-dir]
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { ROOT } from "./lib/load.mjs";

const src = resolve(process.argv[2] ?? join(ROOT, "scene-shots"));
const dest = join(ROOT, "site", "public", "screenshots");
const catalog = JSON.parse(readFileSync(join(ROOT, "site", "public", "catalog.json"), "utf8"));

const referenced = [];
for (const base of catalog.bases ?? []) referenced.push({ what: `base ${base.id}`, path: base.image });
for (const tool of catalog.tools) {
  for (const variant of tool.variants) {
    referenced.push({ what: `${tool.id} ${variant.id}`, path: variant.screenshot });
  }
}
if (referenced.length === 0) {
  console.error("copy-screenshots: the catalog references no images (run build-catalog first)");
  process.exit(1);
}

const problems = [];
mkdirSync(dest, { recursive: true });
for (const { what, path } of referenced) {
  const file = join(src, basename(path));
  if (!existsSync(file)) {
    problems.push(`${what}: ${basename(path)} is missing in ${src}`);
    continue;
  }
  if (statSync(file).size === 0) {
    problems.push(`${what}: ${basename(path)} is empty`);
    continue;
  }
  copyFileSync(file, join(dest, basename(path)));
}

if (problems.length) {
  console.error(`copy-screenshots: ${problems.length} image problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`copy-screenshots: ${referenced.length} image(s) copied to site/public/screenshots`);
