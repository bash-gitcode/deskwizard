#!/usr/bin/env node
// Writes the static installer under site/public/v1/ from site/public/catalog.json:
//   v1/install.sh          copy of site/src/installer.sh (the same file for every build)
//   v1/install.sh.sha256   sha256 of v1/install.sh, shown on the Review page (sha256sum format)
//   v1/uninstall.sh        copy of site/src/uninstall.sh
//   v1/manifest.json       the ids the installer accepts, plus sha256 of every file under v1/files/
//   v1/files/**            plain-text catalog data, one file per item (no code, only key=value and TAB-separated rows)
//   install.sh             alias of v1/install.sh, kept for links made before the build code existed
// Run after build-catalog: npm run build-catalog && node scripts/generate-install.mjs
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./lib/load.mjs";

const PUBLIC = join(ROOT, "site", "public");
const SRC = join(ROOT, "site", "src");
const V1 = join(PUBLIC, "v1");
const catalog = JSON.parse(readFileSync(join(PUBLIC, "catalog.json"), "utf8"));
const DISTROS = catalog.distros.map((d) => d.id);

rmSync(V1, { recursive: true, force: true });
const files = []; // { path, sha256 } for everything under v1/files/
const ids = []; // "kind id" strings the installer accepts

const dash = (v) => (v === null || v === undefined || v === "" ? "-" : String(v));
const TAB = "\t";

// Writes one data file and records its sha256 in the manifest.
function putData(rel, text) {
  const bytes = Buffer.from(text, "utf8");
  const abs = join(V1, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  files.push({ path: rel, sha256: createHash("sha256").update(bytes).digest("hex") });
}
// Writes a catalog file (a shipped config or wallpaper) as-is; binary files come from base64.
function putRaw(rel, content, binary) {
  const bytes = binary ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  const abs = join(V1, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  files.push({ path: rel, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const bindRows = (binds) => binds.map((b) => ["bind", b.key, b.command, dash(b.label)].join(TAB) + "\n").join("");

// Distros
for (const d of catalog.distros) {
  ids.push(`distro ${d.id}`);
  putData(
    `files/distros/${d.id}.txt`,
    [`name=${d.name}`, `status=${d.status}`, `os_id=${dash(d.os_release?.ID)}`, `os_version=${dash(d.os_release?.VERSION_ID)}`]
      .map((l) => l + "\n")
      .join("")
  );
}

// Display (Wayland is the only option the installer supports)
ids.push("display wayland");

// Fonts
ids.push(...catalog.fonts.fonts.map((f) => `font ${f.id}`));
for (const f of catalog.fonts.fonts) {
  putData(
    `files/fonts/${f.id}.txt`,
    [
      `name=${f.name}`,
      `family=${dash(f.family)}`,
      `archive=${dash(f.archive)}`,
      `sha256=${dash(f.sha256)}`,
      `dest=${dash(f.dest)}`,
      `fallback=${dash(f.fallback_package)}`,
      `version=${dash(catalog.fonts.version)}`,
      `dest_root=${dash(catalog.fonts.dest_root)}`,
    ]
      .map((l) => l + "\n")
      .join("")
  );
}

// Palettes: one token=value line per token
ids.push(...catalog.palettes.map((p) => `palette ${p.id}`));
for (const p of catalog.palettes) {
  putData(
    `files/palettes/${p.id}.txt`,
    Object.entries(p.tokens)
      .map(([k, v]) => `${k}=${v}\n`)
      .join("")
  );
}

// Start methods
ids.push(...catalog.start_methods.map((s) => `start ${s.id}`));
for (const s of catalog.start_methods) {
  putData(
    `files/starts/${s.id}.txt`,
    DISTROS.map((d) => (s.packages[d] ?? []).map((p) => `package.${d}=${p}\n`).join("")).join("")
  );
}

// Extras (order = catalog order, which the installer uses to sort)
ids.push(...catalog.extras.map((e) => `extra ${e.id}`));
catalog.extras.forEach((e, i) => {
  putData(
    `files/extras/${e.id}.txt`,
    [
      `order=${i}`,
      ...DISTROS.flatMap((d) => (e.packages[d] ?? []).map((p) => `package.${d}=${p}`)),
      ...e.autostart.map((a) => `autostart=${a}`),
    ]
      .map((l) => l + "\n")
      .join("") + bindRows(e.binds)
  );
});

// Tools and their variants
ids.push(...catalog.tools.map((t) => `tool ${t.id}`));
for (const t of catalog.tools) {
  for (const v of t.variants) ids.push(`variant ${t.id} ${v.id}`);
  const head = [
    `type=${t.type}`,
    `order=${t.display.order}`,
    ...DISTROS.flatMap((d) => (t.packages[d] ?? []).map((p) => `package.${d}=${p}`)),
    ...t.requires.map((r) => `requires=${r}`),
    ...t.extras.map((e) => `extra=${e}`),
    ...t.autostart.map((a) => `autostart=${a}`),
    `command=${dash(t.command)}`,
    ...t.variants.flatMap((v) => (v.requires ?? []).map((r) => `variant_requires=${v.id} ${r}`)),
    ...t.variants.map((v) => `variant=${v.id}`),
    ...t.install.map((i) => ["install", i.from, i.source, i.target, i.binary ? "binary" : "text"].join(TAB)),
  ];
  putData(`files/tools/${t.id}.txt`, head.map((l) => l + "\n").join("") + bindRows(t.binds));

  // Shipped config files, verified by the manifest like everything else.
  for (const [name, text] of Object.entries(t.files)) putRaw(`files/tools/${t.id}/src/${name}`, text, false);
  for (const v of t.variants) {
    for (const item of t.install.filter((i) => i.from === "variant")) {
      const content = v.files[item.source];
      if (content === undefined) throw new Error(`${t.id}/${v.id}: no file for install source ${item.source}`);
      putRaw(`files/variants/${t.id}/${v.id}/${item.source}`, content, Boolean(item.binary));
    }
  }
}

// Install script, uninstall script, and the manifest that lists every file.
mkdirSync(V1, { recursive: true });
copyFileSync(join(SRC, "installer.sh"), join(V1, "install.sh"));
copyFileSync(join(SRC, "uninstall.sh"), join(V1, "uninstall.sh"));
const installBytes = readFileSync(join(V1, "install.sh"));
const installSha = createHash("sha256").update(installBytes).digest("hex");
writeFileSync(join(V1, "install.sh.sha256"), `${installSha}  install.sh\n`);
copyFileSync(join(V1, "install.sh"), join(PUBLIC, "install.sh"));

const manifest = {
  catalog_version: catalog.catalog_version,
  ids,
  files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
};
const json = [
  "{",
  `  "catalog_version": ${JSON.stringify(manifest.catalog_version)},`,
  '  "ids": [',
  ids.map((i) => `    ${JSON.stringify(i)}`).join(",\n"),
  "  ],",
  '  "files": [',
  manifest.files.map((f) => `    { "path": ${JSON.stringify(f.path)}, "sha256": "${f.sha256}" }`).join(",\n"),
  "  ]",
  "}",
  "",
].join("\n");
writeFileSync(join(V1, "manifest.json"), json);
console.log(
  `generate-install: wrote site/public/v1 (${ids.length} ids, ${files.length} data files, install.sh sha256 ${installSha})`
);
