#!/usr/bin/env node
// Fails if a distro claims a support level that the CI jobs do not prove.
//   package-checked needs the package-check and first-run jobs in ci.yml, both on debian:trixie.
//   verified-vm needs a maintainer VM run. CI has no VM job, so the claim is refused.
//   community makes no claim and needs no evidence.
// Run with: npm run -s check-support
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, CATALOG, readYaml } from "./lib/load.mjs";

const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const jobHas = (job) => new RegExp(`^  ${job}:\\n`, "m").test(ci);
// Split ci.yml into job blocks (two-space indent under `jobs:`), then record which jobs run on debian:trixie.
const jobBlocks = ci.split(/^(?=  [a-z0-9-]+:\n)/m).filter((b) => /^  [a-z0-9-]+:\n/.test(b));
const trixieJobs = jobBlocks
  .filter((b) => /^\s+(container|image): debian:trixie\s*$/m.test(b))
  .map((b) => b.match(/^  ([a-z0-9-]+):/)[1]);

const distros = readYaml(join(CATALOG, "distros.yaml"));
const errors = [];

for (const d of distros) {
  if (d.support === "community") continue;
  if (d.support === "verified-vm") {
    errors.push(`${d.id}: support verified-vm, but CI has no VM job. Only package-checked is proven.`);
    continue;
  }
  if (d.support === "package-checked") {
    if (d.status !== "available") errors.push(`${d.id}: package-checked but status is ${d.status}`);
    if (!jobHas("package-check")) errors.push(`${d.id}: package-checked but ci.yml has no package-check job`);
    if (!jobHas("first-run")) errors.push(`${d.id}: package-checked but ci.yml has no first-run job`);
    if (!trixieJobs.includes("first-run")) errors.push(`${d.id}: first-run job does not run on debian:trixie`);
    continue;
  }
  errors.push(`${d.id}: unknown support level ${d.support}`);
}

if (errors.length) {
  console.error("check-support: support levels claim more than CI proves:\n");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`check-support: ${distros.length} distros, every support level is backed by CI`);
