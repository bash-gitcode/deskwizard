#!/usr/bin/env node
// Self-tests for the guards. Each guard must fail on a planted bad input and pass on a good one, so a guard
// that silently stops checking fails CI here. Run with: node scripts/guard-selftest.mjs (needs python3 for the
// duplicate guard).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(new URL(".", import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "guard-selftest-"));
const failures = [];

function expect(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
    failures.push(name);
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

// Palette guard
const palettes = join(tmp, "palettes");
mkdirSync(palettes);
writeFileSync(join(palettes, "planted.yaml"), "name: planted\nbackground: \"#1e1e2e\"\nforeground: \"#cdd6f4\"\n");
const bad = run("node", [join(here, "check-palettes.mjs"), palettes]);
expect("palette guard fails on a Catppuccin hex", bad.status !== 0 && /Catppuccin/.test(bad.output), bad.output.trim());

const goodDir = join(tmp, "palettes-good");
mkdirSync(goodDir);
writeFileSync(join(goodDir, "original.yaml"), "name: original\nbackground: \"#123a5c\"\nforeground: \"#f0e6d2\"\n");
const good = run("node", [join(here, "check-palettes.mjs"), goodDir]);
expect("palette guard passes an original palette", good.status === 0, good.output.trim());

const real = run("node", [join(here, "check-palettes.mjs")]);
expect("palette guard passes the real catalog", real.status === 0, real.output.trim());

// Duplicate guard
const shots = join(tmp, "shots");
mkdirSync(shots);
writeFileSync(join(shots, "foot-classic.webp"), "same bytes");
writeFileSync(join(shots, "foot-underline.webp"), "same bytes");
writeFileSync(join(shots, "swaybg-dusk.webp"), "different bytes");
const emptyAllow = join(tmp, "empty.json");
writeFileSync(emptyAllow, JSON.stringify({ allowed: [] }));
const dupBad = run("python3", [join(here, "shots", "check-duplicates.py"), shots, emptyAllow]);
expect("duplicate guard fails on a planted duplicate pair", dupBad.status !== 0 && /foot-classic\.webp and foot-underline\.webp/.test(dupBad.output), dupBad.output.trim());

const pairAllow = join(tmp, "pair.json");
writeFileSync(pairAllow, JSON.stringify({ allowed: [{ files: ["foot-classic.webp", "foot-underline.webp"], reason: "self-test" }] }));
const dupAllowed = run("python3", [join(here, "shots", "check-duplicates.py"), shots, pairAllow]);
expect("duplicate guard passes the same pair once it is allowlisted", dupAllowed.status === 0, dupAllowed.output.trim());

const distinct = join(tmp, "distinct");
mkdirSync(distinct);
writeFileSync(join(distinct, "a.webp"), "one");
writeFileSync(join(distinct, "b.webp"), "two");
const dupGood = run("python3", [join(here, "shots", "check-duplicates.py"), distinct, emptyAllow]);
expect("duplicate guard passes distinct images", dupGood.status === 0, dupGood.output.trim());

rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`guard-selftest: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("guard-selftest: all passed");
