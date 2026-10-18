#!/usr/bin/env node
// Checks the built site/public/v1 output against the files on disk. Run after `npm run build`.
// It fails if:
//   - a file listed in manifest.json is missing or its sha256 differs
//   - a file under v1/files/ is not listed in manifest.json
//   - v1/install.sh or v1/uninstall.sh differs from the source in site/src/
//   - v1/install.sh.sha256 does not match v1/install.sh
//   - manifest.catalog_version differs from catalog.json
// Note: this compares the build output with its sources. Run it after a fresh build so it checks current output.
// Run: npm run check-manifest
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./lib/load.mjs";

const PUBLIC = join(ROOT, "site", "public");
const SRC = join(ROOT, "site", "src");
const V1 = join(PUBLIC, "v1");
const errors = [];
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

for (const f of ["manifest.json", "install.sh", "install.sh.sha256", "uninstall.sh"]) {
  if (!existsSync(join(V1, f))) errors.push(`site/public/v1/${f} is missing. Run npm run build first.`);
}
if (errors.length) {
  console.error("check-manifest: FAIL");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(V1, "manifest.json"), "utf8"));
const listed = new Set();
for (const entry of manifest.files) {
  listed.add(entry.path);
  const p = join(V1, entry.path);
  if (!existsSync(p)) {
    errors.push(`manifest lists ${entry.path} but the file is missing`);
  } else if (sha256(p) !== entry.sha256) {
    errors.push(`${entry.path}: sha256 differs from manifest.json (manifest is out of date)`);
  }
}

const filesDir = join(V1, "files");
if (existsSync(filesDir)) {
  for (const p of walk(filesDir)) {
    const rel = relative(V1, p);
    if (!listed.has(rel)) errors.push(`${rel} is on disk but not listed in manifest.json`);
  }
}

for (const name of ["install.sh", "uninstall.sh"]) {
  const src = join(SRC, name === "install.sh" ? "installer.sh" : "uninstall.sh");
  if (sha256(src) !== sha256(join(V1, name))) errors.push(`v1/${name} differs from site/src (run generate-install)`);
}

const recorded = readFileSync(join(V1, "install.sh.sha256"), "utf8").split(/\s+/)[0];
if (recorded !== sha256(join(V1, "install.sh"))) errors.push("v1/install.sh.sha256 does not match v1/install.sh");

const catalog = JSON.parse(readFileSync(join(PUBLIC, "catalog.json"), "utf8"));
if (manifest.catalog_version !== catalog.catalog_version) {
  errors.push(`manifest catalog_version ${manifest.catalog_version} differs from catalog.json ${catalog.catalog_version}`);
}

if (errors.length) {
  console.error("check-manifest: FAIL");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-manifest: PASS (${manifest.files.length} data files, installer hashes match)`);
