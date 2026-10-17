#!/usr/bin/env node
// Renders every bundled wallpaper from its SVG source to a 2560x1440 PNG.
// The PNGs are build output (gitignored); the SVG sources are committed.
// The SVGs are original drawings for this project, so there are no image licenses to track.
// Run: npm run render-wallpapers
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const variantsDir = join(root, "catalog/tools/swaybg/variants");
const WIDTH = 2560;
const HEIGHT = 1440;

// PNG width and height are stored in the IHDR chunk at bytes 16..23.
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let failed = false;
for (const id of readdirSync(variantsDir).sort()) {
  const svgPath = join(variantsDir, id, "wallpaper.svg");
  if (!existsSync(svgPath)) {
    console.error(`MISSING: ${svgPath}`);
    failed = true;
    continue;
  }
  const svg = readFileSync(svgPath);
  const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng();
  const size = pngSize(png);
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    console.error(`BAD SIZE: ${svgPath} rendered ${size.width}x${size.height}, expected ${WIDTH}x${HEIGHT}`);
    failed = true;
    continue;
  }
  const out = join(variantsDir, id, "wallpaper.png");
  writeFileSync(out, png);
  console.log(`wrote ${out} (${size.width}x${size.height})`);
}
if (failed) process.exit(1);
