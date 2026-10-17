#!/usr/bin/env node
// Validates the whole catalog. Prints every problem it finds, then exits 1 if any.
// Run with: npm run validate
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { CATALOG, loadCatalog, readYaml, readText, parseJsonc, rel } from "./lib/load.mjs";

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

    // config.jsonc: must parse, and must agree with meta.options
    const cfgPath = join(v.path, "config.jsonc");
    if (!existsSync(cfgPath)) fail(mfile, "missing config.jsonc next to meta.yaml.");
    else {
      try {
        const cfg = parseJsonc(readText(cfgPath));
        const cfile = rel(cfgPath);
        if (cfg.height !== meta.options.height) fail(cfile, `height ${cfg.height} differs from meta.yaml options.height ${meta.options.height}.`);
        if (cfg.position !== meta.options.position) fail(cfile, `position '${cfg.position}' differs from meta.yaml options.position '${meta.options.position}'.`);
      } catch (e) {
        fail(rel(cfgPath), `config.jsonc is not valid JSON(C): ${e.message}`);
      }
    }

    // style.css: palette names must be @define-color lines, and no other color literals
    const stylePath = join(v.path, "style.css");
    if (!existsSync(stylePath)) fail(mfile, "missing style.css next to meta.yaml.");
    else {
      const css = readText(stylePath);
      const sfile = rel(stylePath);
      const defined = new Map();
      for (const m of css.matchAll(/@define-color\s+([a-z_]+)\s+(#[0-9a-fA-F]{6});/g)) defined.set(m[1], m[2].toLowerCase());
      for (const [name, hex] of Object.entries(meta.palette)) {
        if (defined.get(name) !== hex.toLowerCase()) fail(sfile, `palette '${name}' (${hex}) must be defined as '@define-color ${name} ${hex};'.`);
      }
      // Remove the allowed define-color lines, then look for any remaining color literal.
      const outside = css.replace(/@define-color[^;]*;/g, "");
      const literal = outside.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
      if (literal) fail(sfile, `color literal '${literal[0]}' outside @define-color lines. Use a palette @name instead.`);
    }

    if (!existsSync(join(v.path, meta.screenshot))) fail(mfile, `screenshot '${meta.screenshot}' does not exist.`);
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
