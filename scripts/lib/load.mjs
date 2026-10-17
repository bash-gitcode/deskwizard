// Shared catalog loader. Reads everything under catalog/ and returns plain data.
// Used by validate.mjs and build-catalog.mjs so both see the same catalog.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CATALOG = join(ROOT, "catalog");

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function readYaml(path) {
  return parseYaml(readText(path));
}

// JSONC: we only allow full-line // comments, so stripping them is safe.
export function parseJsonc(text) {
  const stripped = text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
  return JSON.parse(stripped);
}

function dirs(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory()).sort();
}

// Returns { ok, errors[], catalog? }. Loading problems are collected, not thrown,
// so validate.mjs can report everything at once.
export function loadCatalog() {
  const tools = [];
  const toolsDir = join(CATALOG, "tools");
  for (const dir of dirs(toolsDir)) {
    const toolDir = join(toolsDir, dir);
    const toolYamlPath = join(toolDir, "tool.yaml");
    const variants = [];
    const variantsDir = join(toolDir, "variants");
    for (const v of dirs(variantsDir)) {
      const variantDir = join(variantsDir, v);
      variants.push({ dir: v, path: variantDir });
    }
    tools.push({ dir, path: toolDir, yamlPath: toolYamlPath, variants });
  }
  return {
    distrosPath: join(CATALOG, "distros.yaml"),
    fontsPath: join(CATALOG, "fonts.yaml"),
    schemaDir: join(CATALOG, "schema"),
    tools,
  };
}

export function rel(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}
