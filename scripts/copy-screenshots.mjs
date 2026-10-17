// Copies the smoke-test screenshots (smoke-out/<tool>-<variant>.png) into site/public/screenshots.
// Fails if any smoke variant has no screenshot, so the Pages build cannot ship a site with missing images.
//   node scripts/copy-screenshots.mjs [smoke-out-dir]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./lib/load.mjs";

const src = resolve(process.argv[2] ?? join(ROOT, "smoke-out"));
const dest = join(ROOT, "site", "public", "screenshots");

const listing = execFileSync(process.execPath, [join(ROOT, "scripts", "smoke-stage.mjs"), "list"], {
  encoding: "utf8",
});
const variants = listing.split("\n").filter(Boolean);
if (variants.length === 0) {
  console.error("copy-screenshots: no smoke variants found (run build-catalog first)");
  process.exit(1);
}

const missing = [];
mkdirSync(dest, { recursive: true });
for (const line of variants) {
  const [tool, variant] = line.split(" ");
  const name = `${tool}-${variant}.png`;
  const file = join(src, name);
  if (!existsSync(file)) {
    missing.push(name);
    continue;
  }
  copyFileSync(file, join(dest, name));
}

if (missing.length) {
  console.error(`copy-screenshots: ${missing.length} screenshot(s) missing in ${src}:`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`copy-screenshots: ${variants.length} screenshot(s) copied to site/public/screenshots`);
