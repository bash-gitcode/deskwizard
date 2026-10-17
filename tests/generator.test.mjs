// Run with: node --test tests/   (needs site/public/catalog.json, so run npm run build-catalog first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlan,
  buildCode,
  parseCode,
  toPayload,
  fromPayload,
  toBase64,
  fromBase64,
  SCHEMA_VERSION,
  MAX_CODE_LENGTH,
  missingExtras,
} from "../site/src/generator.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "site", "public", "catalog.json"), "utf8"));

const sway = {
  distro: "debian13",
  display: "wayland",
  font: "jetbrains-mono",
  palette: "midnight",
  start: "manual",
  extras: [],
  choices: { sway: { variant: null }, waybar: { variant: "minimal" } },
};

test("payload stores only choices and versions", () => {
  const payload = toPayload(sway, catalog.catalog_version);
  assert.equal(payload.schema_version, SCHEMA_VERSION);
  assert.equal(payload.catalog_version, catalog.catalog_version);
  assert.deepEqual(Object.keys(payload).sort(), ["catalog_version", "choices", "schema_version"]);
  assert.deepEqual(Object.keys(payload.choices).sort(), ["display", "distro", "extras", "font", "palette", "start_method", "tools"]);
});

test("schema 4 round trip keeps the build, including start_method", () => {
  const { state, notices } = fromPayload(toPayload({ ...sway, start: "greetd" }, catalog.catalog_version), catalog.catalog_version, catalog);
  assert.deepEqual(notices, []);
  assert.equal(state.start, "greetd");
  assert.equal(state.font, "jetbrains-mono");
  assert.deepEqual(state.choices, { sway: { variant: null }, waybar: { variant: "minimal" } });
});

test("schema 3 and 2 payloads load with start method manual and a notice", () => {
  const s3 = { ...toPayload(sway, catalog.catalog_version), schema_version: 3 };
  delete s3.choices.start_method;
  const { state, notices } = fromPayload(s3, catalog.catalog_version, catalog);
  assert.equal(state.start, "manual");
  assert.ok(notices.some((n) => /start methods existed/.test(n)));
});

test("old catalog version loads with a notice, not an error", () => {
  const old = toPayload(sway, "0.0.1");
  const { state, notices } = fromPayload(old, catalog.catalog_version, catalog);
  assert.ok(notices.some((n) => /older catalog/.test(n)));
  assert.equal(state.font, "jetbrains-mono");
});

test("schema 1 link (flat choices, no font) still resolves", () => {
  const v1 = { deskwizard: 1, distro: "debian13", display: "wayland", choices: { sway: { variant: null }, waybar: { variant: "minimal" } } };
  const { state, notices } = fromPayload(v1, catalog.catalog_version, catalog);
  assert.equal(state.font, null);
  assert.equal(state.start, "manual");
  assert.equal(state.choices.waybar.variant, "minimal");
  assert.ok(notices.some((n) => /schema 1/.test(n)));
});

test("unknown format is refused with a plain message", () => {
  assert.throws(() => fromPayload({ schema_version: 99 }, catalog.catalog_version, catalog), /Unknown build format/);
  assert.throws(() => fromPayload(null, catalog.catalog_version, catalog), /not a deskwizard build/);
});

test("base64 is UTF-8 safe", () => {
  const text = "Wäybar ✓ — ok";
  assert.equal(fromBase64(toBase64(text)), text);
});

test("build code round trips through parseCode and is base64url data only", () => {
  const code = buildCode({ ...sway, start: "tty1" }, catalog.catalog_version);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  const payload = parseCode(code);
  assert.equal(payload.schema_version, SCHEMA_VERSION);
  assert.equal(payload.catalog_version, catalog.catalog_version);
  assert.equal(payload.choices.start_method, "tty1");
  assert.equal(payload.choices.distro, "debian13");
  assert.deepEqual(payload.choices.tools, { sway: { variant: null }, waybar: { variant: "minimal" } });
});

test("parseCode rejects an oversized code", () => {
  assert.throws(() => parseCode("A".repeat(MAX_CODE_LENGTH + 1)), /longer than/);
});

test("parseCode rejects malformed input with a plain message", () => {
  assert.throws(() => parseCode("not base64!"), /malformed/);
  assert.throws(() => parseCode(""), /empty/);
  assert.throws(() => parseCode(toBase64("schema=4\n")), /missing 'catalog'/);
  assert.throws(() => parseCode(toBase64("schema=4\ndistro=debian13\n")), /malformed|missing/);
  assert.throws(() => parseCode(toBase64("schema=4\nevil=$(id)\n")), /malformed/);
  assert.throws(() => parseCode(toBase64("schema=4\nschema=4\n")), /repeats/);
});

// buildPlan returns { ok, errors, plan }; these tests use the inner plan.
const planOf = (state) => {
  const result = buildPlan(state, catalog);
  assert.equal(result.ok, true, result.errors.join("; "));
  return result.plan;
};

test("font choice reaches the plan", () => {
  const plan = planOf({ ...sway, font: "jetbrains-mono" });
  assert.equal(plan.downloadFont, true);
});

test("Font Awesome only means no download", () => {
  const plan = planOf({ ...sway, font: "font-awesome" });
  assert.equal(plan.downloadFont, false);
});

test("a missing compositor is reported, not thrown", () => {
  const result = buildPlan({ ...sway, choices: { waybar: { variant: "minimal" } } }, catalog);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Choose exactly one compositor/.test(e)));
});

// Extras come in three tiers: required (always included), recommended (offered with Add), optional (no prompt).
const swayOnly = { distro: "debian13", display: "wayland", font: "jetbrains-mono", palette: "midnight", start: "manual", extras: [], choices: { sway: { variant: null } } };

test("required extras are always in the plan, and are not offered as recommended", () => {
  const plan = planOf(swayOnly);
  assert.ok(plan.packages.includes("xdg-desktop-portal-wlr"), "portal is required by sway");
  assert.ok(plan.packages.includes("lxpolkit"), "polkit agent is required by sway");
  assert.ok(!missingExtras(swayOnly, catalog).includes("portal"));
  assert.ok(!missingExtras(swayOnly, catalog).includes("polkit"));
});

test("recommended extras are offered, not installed, until the user adds them", () => {
  const plan = planOf(swayOnly);
  assert.deepEqual(missingExtras(swayOnly, catalog), ["screenshot"]);
  assert.ok(!plan.packages.includes("slurp"), "screenshot tools are not installed unless accepted");
  assert.ok(!plan.binds.some((b) => b.key === "Print"));
});

test("an accepted recommended extra is installed with its binds", () => {
  const state = { ...swayOnly, extras: ["screenshot"] };
  const plan = planOf(state);
  assert.ok(plan.packages.includes("slurp"));
  assert.ok(plan.binds.some((b) => b.key === "Print"));
  assert.deepEqual(missingExtras(state, catalog), []);
});

test("optional extras are never prompted or installed by default", () => {
  const plan = planOf(swayOnly);
  assert.ok(!missingExtras(swayOnly, catalog).includes("media-keys"));
  assert.ok(!plan.packages.includes("brightnessctl"));
});

test("start methods: greetd adds greetd and tuigreet packages, manual adds none", () => {
  const manual = catalog.start_methods.find((s) => s.id === "manual");
  const greetd = catalog.start_methods.find((s) => s.id === "greetd");
  assert.deepEqual(manual.packages.debian13, []);
  assert.deepEqual(greetd.packages.debian13, ["greetd", "tuigreet"]);
});
