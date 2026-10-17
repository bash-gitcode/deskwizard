#!/usr/bin/env node
// Validates the whole catalog. Prints every problem it finds, then exits 1 if any.
// Run with: npm run validate
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { CATALOG, loadCatalog, readYaml, readText, parseJsonc, rel } from "./lib/load.mjs";
import { resolveTokens, PALETTE_COLOR_TOKENS, PALETTE_FONT_TOKENS } from "../site/src/generator.js";

const errors = [];
const fail = (file, message) => errors.push(`[${file}] ${message}`);

const ajv = new Ajv2020({ allErrors: true, strict: false });

// Turn ajv's terse errors into messages that name the missing or wrong field.
function explain(file, schemaErrors) {
  for (const err of schemaErrors) {
    const where = err.instancePath || "(root)";
    if (err.keyword === "required") {
      const field = err.params.missingProperty;
      fail(file, `missing required field '${field}' at ${where}. Add it to the file.`);
    } else if (err.keyword === "additionalProperties") {
      fail(file, `unknown field '${err.params.additionalProperty}' at ${where}.`);
    } else {
      fail(file, `field ${where}: ${err.message}`);
    }
  }
}

const compiled = new Map();
function checkSchema(schemaFile, data, file) {
  if (!compiled.has(schemaFile)) {
    const schema = JSON.parse(readText(join(CATALOG, "schema", schemaFile)));
    compiled.set(schemaFile, ajv.compile(schema));
  }
  const validate = compiled.get(schemaFile);
  if (!validate(data)) {
    explain(file, validate.errors);
    return false;
  }
  return true;
}

const cat = loadCatalog();

// 1. Distros
let distroIds = [];
{
  const file = rel(cat.distrosPath);
  const distros = readYaml(cat.distrosPath);
  if (checkSchema("distro.schema.json", distros, file)) {
    distroIds = distros.map((d) => d.id);
    if (!distros.some((d) => d.status === "available")) fail(file, "no distro has status 'available'.");
  }
}

// 2. Fonts (installer pin)
{
  const file = rel(cat.fontsPath);
  const fonts = readYaml(cat.fontsPath);
  if (!fonts || typeof fonts !== "object") fail(file, "fonts.yaml must be a mapping.");
  else {
    for (const key of ["version", "default", "dest_root", "fonts"]) {
      if (fonts[key] === undefined) fail(file, `missing required field '${key}'.`);
    }
    const ids = [];
    for (const [i, f] of (fonts.fonts ?? []).entries()) {
      for (const key of ["id", "name", "family", "archive", "sha256", "dest", "fallback_package"]) {
        if (!(key in f)) fail(file, `fonts[${i}] is missing required field '${key}' (use null if not applicable).`);
      }
      if (ids.includes(f.id)) fail(file, `duplicate font id '${f.id}'.`);
      ids.push(f.id);
      if (f.archive !== null && !/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) {
        fail(file, `font '${f.id}' has an archive, so sha256 must be 64 lowercase hex chars.`);
      }
    }
    if (!ids.includes(fonts.default)) fail(file, `default '${fonts.default}' does not match any font id (${ids.join(", ")}).`);
  }
}

// 2b. Palettes (tokens used by variant files)
const palettes = [];
for (const name of readdirSync(join(CATALOG, "palettes")).filter((n) => n.endsWith(".yaml")).sort()) {
  const file = rel(join(CATALOG, "palettes", name));
  const p = readYaml(join(CATALOG, "palettes", name));
  if (!checkSchema("palette.schema.json", p, file)) continue;
  if (p.id !== name.replace(/\.yaml$/, "")) fail(file, `id '${p.id}' must match the file name.`);
  for (const t of [...PALETTE_COLOR_TOKENS, ...PALETTE_FONT_TOKENS]) {
    if (!(t in p.tokens)) fail(file, `missing token '${t}'.`);
  }
  palettes.push(p);
}
if (palettes.filter((p) => p.default).length !== 1) fail("catalog/palettes", "exactly one palette must have default: true.");

// 2c. Extras (portal, polkit, screenshot, media keys)
const extraIds = [];
{
  const file = rel(join(CATALOG, "extras.yaml"));
  const extras = readYaml(join(CATALOG, "extras.yaml"));
  if (!Array.isArray(extras)) fail(file, "extras.yaml must be a list of extras.");
  else {
    for (const e of extras) {
      if (!checkSchema("extra.schema.json", e, `${file} (extra '${e?.id ?? "?"}')`)) continue;
      if (extraIds.includes(e.id)) fail(file, `duplicate extra id '${e.id}'.`);
      extraIds.push(e.id);
    }
  }
}

// 3. Tools
const toolIds = new Set();
const toolsById = new Map();
const dirToolIds = new Set(cat.tools.map((t) => t.dir));
for (const tool of cat.tools) {
  const file = rel(tool.yamlPath);
  if (!existsSync(tool.yamlPath)) {
    fail(rel(tool.path), "tool directory has no tool.yaml.");
    continue;
  }
  const data = readYaml(tool.yamlPath);
  if (!checkSchema("tool.schema.json", data, file)) continue;
  if (data.id !== tool.dir) fail(file, `id '${data.id}' must match directory name '${tool.dir}'.`);
  if (toolIds.has(data.id)) fail(file, `duplicate tool id '${data.id}'.`);
  toolIds.add(data.id);
  toolsById.set(data.id, { data, tool });
}

for (const [id, { data, tool }] of toolsById) {
  const file = rel(tool.yamlPath);
  for (const key of Object.keys(data.packages)) {
    if (!distroIds.includes(key)) fail(file, `packages key '${key}' is not a known distro id (${distroIds.join(", ")}).`);
  }
  // Only report references to tools that do not exist at all. A tool that exists but failed
  // its own checks is already reported once, so it is not reported again here.
  for (const ref of [...data.works_with, ...data.requires]) {
    if (!dirToolIds.has(ref)) fail(file, `references unknown tool '${ref}' in works_with/requires.`);
  }
  for (const ref of data.extras ?? []) {
    if (!extraIds.includes(ref)) fail(file, `extras lists unknown extra '${ref}'.`);
  }
  for (const ref of data.recommends ?? []) {
    if (!extraIds.includes(ref)) fail(file, `recommends lists unknown extra '${ref}'.`);
    else if ((data.extras ?? []).includes(ref)) fail(file, `extra '${ref}' is both required (extras) and recommended.`);
  }
  if (data.requires.includes(id)) fail(file, "a tool cannot require itself.");

  // Variants
  const variantIds = [];
  for (const v of tool.variants) {
    if (!/^\d{2}$/.test(v.dir)) fail(rel(v.path), "variant directory must be two digits, e.g. 01.");
  }
  if (data.type === "bar" && tool.variants.length === 0) fail(file, "bar tools need at least one variant directory.");
  if (data.default_variant !== null && tool.variants.length === 0) {
    fail(file, `default_variant '${data.default_variant}' is set but the tool has no variants. Use null.`);
  }

  for (const v of tool.variants) {
    const metaPath = join(v.path, "meta.yaml");
    const mfile = rel(metaPath);
    if (!existsSync(metaPath)) {
      fail(rel(v.path), "variant has no meta.yaml.");
      continue;
    }
    const meta = readYaml(metaPath);
    if (!checkSchema("variant.schema.json", meta, mfile)) continue;
    if (variantIds.includes(meta.id)) fail(mfile, `duplicate variant id '${meta.id}'.`);
    variantIds.push(meta.id);

    for (const req of meta.requires) {
      if (!data.requires.includes(req)) fail(mfile, `requires '${req}' but the tool's tool.yaml does not list it in requires.`);
    }

    // Bar variants ship a Waybar config and style. Other tools ship only their own files.
    const isBar = data.type === "bar";
    // config.jsonc: must parse, and must agree with meta.options
    const cfgPath = join(v.path, "config.jsonc");
    if (!isBar) {
      // no Waybar config expected
    } else if (!existsSync(cfgPath)) fail(mfile, "missing config.jsonc next to meta.yaml.");
    else {
      try {
        const cfg = parseJsonc(readText(cfgPath));
        const cfile = rel(cfgPath);
        if (meta.options) {
          if (cfg.height !== meta.options.height) fail(cfile, `height ${cfg.height} differs from meta.yaml options.height ${meta.options.height}.`);
          if (cfg.position !== meta.options.position) fail(cfile, `position '${cfg.position}' differs from meta.yaml options.position '${meta.options.position}'.`);
        }
      } catch (e) {
        fail(rel(cfgPath), `config.jsonc is not valid JSON(C): ${e.message}`);
      }
    }

    // style.css: palette names must be @define-color lines, and no other color literals
    const stylePath = join(v.path, "style.css");
    if (!isBar) {
      // no Waybar style expected
    } else if (!existsSync(stylePath)) fail(mfile, "missing style.css next to meta.yaml.");
    else {
      const css = readText(stylePath);
      const sfile = rel(stylePath);
      // Remove the allowed define-color lines, then look for any remaining color literal.
      const outside = css.replace(/@define-color[^;]*;/g, "");
      const literal = outside.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
      if (literal) fail(sfile, `color literal '${literal[0]}' outside @define-color lines. Use a palette @name instead.`);
    }

    if (!existsSync(join(v.path, meta.screenshot))) fail(mfile, `screenshot '${meta.screenshot}' does not exist.`);

    // Every palette must resolve every $token in the variant's text files.
    for (const f of readdirSync(v.path)) {
      if (/\.(yaml|svg|png)$/.test(f) || statSync(join(v.path, f)).isDirectory()) continue;
      const text = readText(join(v.path, f));
      for (const p of palettes) {
        const res = resolveTokens(text, p);
        if (res.unknown.length) fail(rel(join(v.path, f)), `unknown palette token ${[...new Set(res.unknown)].join(", ")} (palette ${p.id}).`);
      }
    }
  }

  if (data.default_variant !== null && tool.variants.length > 0 && !variantIds.includes(data.default_variant)) {
    fail(file, `default_variant '${data.default_variant}' does not match any variant id (${variantIds.join(", ")}).`);
  }

  // install entries: the source file must exist
  for (const item of data.install ?? []) {
    if (item.from === "variant" && tool.variants.length === 0) {
      fail(file, `install '${item.source}' is from 'variant' but the tool has no variants.`);
      continue;
    }
    if (item.from === "tool") {
      if (!existsSync(join(tool.path, "files", item.source))) fail(file, `install source 'files/${item.source}' does not exist.`);
    } else {
      // Every variant must ship every variant-sourced file.
      for (const v of tool.variants) {
        if (!existsSync(join(v.path, item.source))) fail(rel(v.path), `missing '${item.source}' required by install.`);
      }
    }
  }
}

if (errors.length) {
  console.error(`validate: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`validate: OK (${cat.tools.length} tools, ${distroIds.length} distros) in ${rel(CATALOG)}`);
