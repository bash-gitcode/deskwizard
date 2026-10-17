#!/usr/bin/env node
// Compiles catalog/ into site/public/catalog.json (the only data the site reads).
// Config and style files are inlined so the browser and the installer need no extra fetches.
// Screenshots are copied to site/public/catalog/. Every referenced file must exist.
// Run with: npm run build-catalog
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadCatalog, readYaml, readText, rel } from "./lib/load.mjs";

const OUT_DIR = join(ROOT, "site", "public");
const OUT_ASSETS = join(OUT_DIR, "catalog");
const missing = [];

function requireFile(path, why) {
  if (!existsSync(path)) missing.push(`${rel(path)} (${why})`);
  return path;
}

const cat = loadCatalog();
const distros = readYaml(cat.distrosPath);
const fonts = readYaml(cat.fontsPath);

// Clean output so removed tools/variants do not linger in the site.
rmSync(OUT_ASSETS, { recursive: true, force: true });
mkdirSync(OUT_ASSETS, { recursive: true });

const tools = [];
for (const tool of cat.tools) {
  const data = readYaml(tool.yamlPath);

  // Tool-level files (e.g. sway.conf), inlined by name.
  const files = {};
  const toolFilesDir = join(tool.path, "files");
  for (const item of data.install ?? []) {
    if (item.from === "tool") {
      files[item.source] = readText(requireFile(join(toolFilesDir, item.source), `install source of ${data.id}`));
    }
  }

  const variants = [];
  for (const v of tool.variants) {
    const meta = readYaml(join(v.path, "meta.yaml"));
    const vfiles = {};
    for (const item of data.install ?? []) {
      if (item.from === "variant") {
        vfiles[item.source] = readText(requireFile(join(v.path, item.source), `install source of ${data.id}/${meta.id}`));
      }
    }
    const shotSrc = requireFile(join(v.path, meta.screenshot), `screenshot of ${data.id}/${meta.id}`);
    const shotRel = `catalog/${data.id}/${meta.id}/${meta.screenshot}`;
    mkdirSync(join(OUT_DIR, "catalog", data.id, meta.id), { recursive: true });
    copyFileSync(shotSrc, join(OUT_DIR, shotRel));

    variants.push({
      id: meta.id,
      name: meta.name,
      dir: v.dir,
      good_for: meta.good_for,
      palette: meta.palette,
      requires: meta.requires,
      options: meta.options,
      screenshot: shotRel,
      files: vfiles,
    });
  }

  tools.push({
    id: data.id,
    name: data.name,
    type: data.type,
    description: data.description,
    needed: data.needed,
    needed_reason: data.needed_reason,
    display: data.display,
    works_with: data.works_with,
    requires: data.requires,
    packages: data.packages,
    difficulty: data.difficulty,
    ram_mb: data.ram_mb,
    default_variant: data.default_variant,
    install: data.install ?? [],
    files,
    variants,
  });
}

if (missing.length) {
  console.error("build-catalog: referenced files are missing:\n");
  for (const m of missing) console.error("  " + m);
  process.exit(1);
}

// catalog_version is the package version. Share links and Save files record it so old builds can be flagged.
const catalogVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const catalog = {
  schema_version: 1,
  catalog_version: catalogVersion,
  distros,
  fonts,
  tools: tools.sort((a, b) => a.display.order - b.display.order),
};

writeFileSync(join(OUT_DIR, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
const variantCount = tools.reduce((n, t) => n + t.variants.length, 0);
console.log(`build-catalog: wrote site/public/catalog.json (${tools.length} tools, ${variantCount} variants)`);
