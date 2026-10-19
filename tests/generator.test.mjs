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
  assert.deepEqual(Object.keys(payload.choices).sort(), ["display", "distro", "extras", "font", "options", "palette", "start_method", "tools"]);
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

test("screenshot and media keys are on by default, with their packages and binds", () => {
  const plan = planOf(swayOnly);
  assert.deepEqual(missingExtras(swayOnly, catalog), []);
  assert.ok(plan.packages.includes("grim") && plan.packages.includes("slurp"), "grim and slurp are in the Sway packages");
  assert.ok(plan.packages.includes("brightnessctl") && plan.packages.includes("playerctl"));
  assert.ok(plan.binds.some((b) => b.key === "Print"));
  assert.ok(plan.binds.some((b) => b.key === "Shift+Print"));
  assert.ok(plan.binds.some((b) => b.key === "XF86AudioRaiseVolume"));
});

test("turning the screenshot or media option off removes its packages and binds", () => {
  const state = { ...swayOnly, options: { sway: { screenshot_keys: false, media_keys: false } } };
  const plan = planOf(state);
  assert.ok(!plan.packages.includes("brightnessctl") && !plan.packages.includes("playerctl"));
  assert.ok(!plan.binds.some((b) => b.key === "Print" || b.key === "XF86AudioRaiseVolume"));
  assert.ok(plan.binds.some((b) => b.key === "$mod+Return"));
});

// Schema 5 options. A schema 4 build code (no option lines) must keep loading and take the defaults.
// Build codes are base64url without padding.
const base64url = (text) => toBase64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const schema4Code = base64url(
  [
    "schema=4",
    `catalog=${catalog.catalog_version}`,
    "distro=debian13",
    "display=wayland",
    "font=jetbrains-mono",
    "palette=midnight",
    "start=manual",
    "tool.sway=-",
    "tool.waybar=minimal",
  ].join("\n") + "\n"
);

test("a stored schema 4 build code loads and takes the option defaults", () => {
  const { state, notices } = fromPayload(parseCode(schema4Code), catalog.catalog_version, catalog);
  assert.deepEqual(notices, []);
  assert.equal(state.start, "manual");
  assert.equal(state.choices.waybar.variant, "minimal");
  const plan = planOf(state);
  assert.ok(plan.packages.includes("sway"));
});

test("a schema 4 saved YAML (payload without options) loads and takes the option defaults", () => {
  const saved = toPayload(swayOnly, catalog.catalog_version);
  const v4 = { ...saved, schema_version: 4, choices: { ...saved.choices } };
  delete v4.choices.options;
  const { state, notices } = fromPayload(v4, catalog.catalog_version, catalog);
  assert.deepEqual(notices, []);
  assert.deepEqual(state.options, {});
  assert.ok(planOf(state).packages.includes("sway"));
});

test("a schema 4 build code with option lines is refused", () => {
  const withOpt = base64url(`schema=4\nopt.sway.gaps_inner=12\ncatalog=${catalog.catalog_version}\ndistro=debian13\ndisplay=wayland\nfont=jetbrains-mono\npalette=midnight\nstart=manual\ntool.sway=-\n`);
  assert.throws(() => parseCode(withOpt), /schema 4 has no options/);
});

test("schema 5 options round trip through the build code and the payload", () => {
  const state = { ...swayOnly, options: { sway: { gaps_inner: 12, smart_gaps: false, keyboard_layout: "us,de", lock_minutes: 5 } } };
  const code = buildCode(state, catalog.catalog_version);
  const payload = parseCode(code);
  assert.equal(payload.schema_version, 5);
  const { state: back, notices } = fromPayload(payload, catalog.catalog_version, catalog);
  assert.deepEqual(notices, []);
  assert.equal(back.options.sway.gaps_inner, 12);
  assert.equal(back.options.sway.smart_gaps, false);
  assert.equal(back.options.sway.keyboard_layout, "us,de");
  assert.equal(back.options.sway.lock_minutes, 5);
});

test("schema 5 option values are written into sway.conf with their text", () => {
  const plan = planOf({ ...swayOnly, options: { sway: { gaps_inner: 12, smart_gaps: false, lock_minutes: 5 } } });
  const conf = plan.files.find((f) => /sway\/config$/.test(f.target)).content;
  assert.match(conf, /^gaps inner 12$/m);
  assert.match(conf, /^smart_gaps off$/m);
  assert.match(conf, /timeout 300 /);
  assert.doesNotMatch(conf, /\{\{(OPT|PAL):/);
});

test("unknown option, out of range, bad pattern and shell characters are each rejected", () => {
  const bad = [
    [{ sway: { no_such_option: 1 } }, /Unknown option 'no_such_option'/],
    [{ sway: { gaps_inner: 999 } }, /must be from 0 to 50/],
    [{ sway: { gaps_inner: 1.5 } }, /whole number/],
    [{ sway: { keyboard_layout: "US!" } }, /not allowed/],
    [{ sway: { keyboard_layout: "us;rm" } }, /not allowed/],
    [{ sway: { smart_gaps: "yes" } }, /on or off/],
    [{ waybar: { gaps_inner: 1 } }, /not in the build/],
  ];
  for (const [options, pattern] of bad) {
    const result = buildPlan({ ...swayOnly, options }, catalog);
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.ok(result.errors.some((e) => pattern.test(e)), `${JSON.stringify(options)}: ${result.errors.join("; ")}`);
  }
});

test("an oversized build code is refused whatever the options are", () => {
  assert.throws(() => parseCode("A".repeat(MAX_CODE_LENGTH + 1)), /longer than/);
});

test("start methods: greetd adds greetd and tuigreet packages, manual adds none", () => {
  const manual = catalog.start_methods.find((s) => s.id === "manual");
  const greetd = catalog.start_methods.find((s) => s.id === "greetd");
  assert.deepEqual(manual.packages.debian13, []);
  assert.deepEqual(greetd.packages.debian13, ["greetd", "tuigreet"]);
});
