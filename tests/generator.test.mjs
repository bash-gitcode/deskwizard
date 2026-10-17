// Run with: node --test tests/   (needs site/public/catalog.json, so run npm run build-catalog first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlan,
  toPayload,
  fromPayload,
  toBase64,
  fromBase64,
  bootstrapCommand,
  fitsOneLine,
  renderScript,
  SCHEMA_VERSION,
} from "../site/src/generator.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "site", "public", "catalog.json"), "utf8"));
const template = readFileSync(join(here, "..", "site", "src", "installer.template.sh"), "utf8");

const sway = { distro: "debian13", display: "wayland", font: "jetbrains-mono", choices: { sway: { variant: null }, waybar: { variant: "minimal" } } };

test("payload stores only choices and versions", () => {
  const payload = toPayload(sway, catalog.catalog_version);
  assert.equal(payload.schema_version, SCHEMA_VERSION);
  assert.equal(payload.catalog_version, catalog.catalog_version);
  assert.deepEqual(Object.keys(payload).sort(), ["catalog_version", "choices", "schema_version"]);
  assert.deepEqual(Object.keys(payload.choices).sort(), ["display", "distro", "extras", "font", "palette", "tools"]);
});

test("round trip keeps the build", () => {
  const { state, notices } = fromPayload(toPayload(sway, catalog.catalog_version), catalog.catalog_version);
  assert.deepEqual(notices, []);
  assert.deepEqual(state, { distro: "debian13", display: "wayland", font: "jetbrains-mono", palette: "midnight", extras: [], choices: { sway: { variant: null }, waybar: { variant: "minimal" } } });
});

test("old catalog version loads with a notice, not an error", () => {
  const old = toPayload(sway, "0.0.1");
  const { state, notices } = fromPayload(old, catalog.catalog_version);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /older catalog/);
  assert.equal(state.font, "jetbrains-mono");
});

test("schema 1 link (flat choices, no font) still resolves", () => {
  const v1 = { deskwizard: 1, distro: "debian13", display: "wayland", choices: { sway: { variant: null }, waybar: { variant: "minimal" } } };
  const { state, notices } = fromPayload(v1, catalog.catalog_version);
  assert.equal(state.font, null);
  assert.equal(state.choices.waybar.variant, "minimal");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /schema 1/);
  const plan = buildPlan({ ...state, font: catalog.fonts.default }, catalog);
  assert.equal(plan.ok, true);
});

test("unknown format is refused with a plain message", () => {
  assert.throws(() => fromPayload({ schema_version: 99 }, catalog.catalog_version), /Unknown build format/);
  assert.throws(() => fromPayload(null, catalog.catalog_version), /not a deskwizard build/);
});

test("base64 is UTF-8 safe", () => {
  const text = "Wäybar ✓ — ok";
  assert.equal(fromBase64(toBase64(text)), text);
});

// buildPlan returns { ok, errors, plan }; these tests use the inner plan.
const planOf = (state) => {
  const result = buildPlan(state, catalog);
  assert.equal(result.ok, true, result.errors.join("; "));
  return result.plan;
};

test("font choice reaches the installer", () => {
  const plan = planOf({ ...sway, font: "jetbrains-mono" });
  assert.equal(plan.downloadFont, true);
  const script = renderScript(plan, catalog.fonts, template);
  assert.match(script, /INSTALL_FONT="true"/);
  assert.match(script, /NERD_FONT_ARCHIVE="JetBrainsMono\.tar\.xz"/);
  assert.match(script, /NERD_FONT_SHA256="04d5e8f9/);
  assert.doesNotMatch(script, /@@/);
});

test("Font Awesome only means no download and no curl", () => {
  const plan = planOf({ ...sway, font: "font-awesome" });
  assert.equal(plan.downloadFont, false);
  assert.equal(plan.packages.includes("curl"), false);
  const script = renderScript(plan, catalog.fonts, template);
  assert.match(script, /INSTALL_FONT="false"/);
});

test("Waybar font placeholder resolves to the chosen family", () => {
  const plan = planOf({ ...sway, font: "hack" });
  const waybarCss = plan.files.find((f) => f.target.endsWith("style.css"));
  assert.ok(waybarCss);
  assert.doesNotMatch(waybarCss.content, /\{\{NERD_FONT\}\}/);
  assert.match(waybarCss.content, /Hack Nerd Font/);
});

test("bootstrap one-liner points at the versioned installer and passes --script", () => {
  const plan = planOf(sway);
  const script = renderScript(plan, catalog.fonts, template);
  const line = bootstrapCommand("https://example.test/v1/install.sh", script);
  assert.match(line, /\/v1\/install\.sh'/);
  assert.match(line, /bash -s -- --script /);
  assert.equal(fitsOneLine(script), true);
});

test("a missing compositor is reported, not thrown", () => {
  const plan = buildPlan({ ...sway, choices: { waybar: { variant: "minimal" } } }, catalog);
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => /Choose exactly one compositor/.test(e)));
});
