#!/usr/bin/env node
// Downloads every pinned Nerd Font archive from the official release and checks its sha256
// against catalog/fonts.yaml. Exits 1 on any mismatch or download failure, naming the font and
// the sha256 that was actually downloaded, so a wrong pin is easy to correct.
// Run with: node scripts/check-fonts.mjs   (network access to github.com required)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "./lib/load.mjs";

const fonts = parse(readFileSync(join(ROOT, "catalog", "fonts.yaml"), "utf8"));
const base = `https://github.com/ryanoasis/nerd-fonts/releases/download/${fonts.version}`;
let failures = 0;

for (const font of fonts.fonts) {
  if (!font.archive) {
    console.log(`check-fonts: ${font.id}: no archive (apt only), skipped`);
    continue;
  }
  const url = `${base}/${font.archive}`;
  let bytes;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    failures++;
    console.error(`check-fonts: FAIL ${font.id}: could not download ${url} (${err.message})`);
    continue;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual === font.sha256) {
    console.log(`check-fonts: PASS ${font.id} ${font.archive} sha256 ${actual}`);
  } else {
    failures++;
    console.error(
      `check-fonts: FAIL ${font.id} ${font.archive}: catalog pins ${font.sha256} but the release has ${actual}. ` +
        `Update catalog/fonts.yaml to ${actual} only after checking it against SHA-256.txt in release ${fonts.version}.`
    );
  }
}

if (failures) {
  console.error(`check-fonts: ${failures} font(s) failed`);
  process.exit(1);
}
console.log("check-fonts: all pinned fonts match");
