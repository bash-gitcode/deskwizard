#!/usr/bin/env node
// Palette guard: fails if any hex value in catalog/palettes/ is a colour from a well-known theme.
// The palettes must be original. The denylist is a starting list of published theme colours (background,
// foreground and accent values); extend it when a new theme is found. Run with: node scripts/check-palettes.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, rel } from "./lib/load.mjs";

const DENYLIST = {
  // Catppuccin Mocha
  "1e1e2e": "Catppuccin", "181825": "Catppuccin", "11111b": "Catppuccin", "cdd6f4": "Catppuccin", "cba6f7": "Catppuccin",
  // Gruvbox dark
  "282828": "Gruvbox", "ebdbb2": "Gruvbox", "cc241d": "Gruvbox", "98971a": "Gruvbox", "d79921": "Gruvbox",
  "458588": "Gruvbox", "689d6a": "Gruvbox",
  // Nord
  "2e3440": "Nord", "3b4252": "Nord", "434c5e": "Nord", "4c566a": "Nord", "d8dee9": "Nord", "eceff4": "Nord",
  "88c0d0": "Nord", "81a1c1": "Nord", "5e81ac": "Nord", "bf616a": "Nord", "a3be8c": "Nord", "b48ead": "Nord",
  // Dracula
  "282a36": "Dracula", "44475a": "Dracula", "f8f8f2": "Dracula", "6272a4": "Dracula", "bd93f9": "Dracula",
  "ff79c6": "Dracula", "50fa7b": "Dracula", "ff5555": "Dracula",
  // Tokyo Night
  "1a1b26": "Tokyo Night", "24283b": "Tokyo Night", "c0caf5": "Tokyo Night", "7aa2f7": "Tokyo Night",
  "bb9af7": "Tokyo Night", "9ece6a": "Tokyo Night", "f7768e": "Tokyo Night",
  // Rose Pine
  "191724": "Rose Pine", "1f1d2e": "Rose Pine", "26233a": "Rose Pine", "e0def4": "Rose Pine", "c4a7e7": "Rose Pine",
  "ebbcba": "Rose Pine", "9ccfd8": "Rose Pine", "f6c177": "Rose Pine", "eb6f92": "Rose Pine", "31748f": "Rose Pine",
  // Everforest
  "2d353b": "Everforest", "343f44": "Everforest", "d3c6aa": "Everforest", "a7c080": "Everforest",
  "e67e80": "Everforest", "7fbbb3": "Everforest", "dbbc7f": "Everforest",
  // Solarized
  "002b36": "Solarized", "073642": "Solarized", "586e75": "Solarized", "657b83": "Solarized", "839496": "Solarized",
  "93a1a1": "Solarized", "eee8d5": "Solarized", "fdf6e3": "Solarized", "b58900": "Solarized", "cb4b16": "Solarized",
  "dc322f": "Solarized", "d33682": "Solarized", "6c71c4": "Solarized", "268bd2": "Solarized", "2aa198": "Solarized",
  "859900": "Solarized",
};

// Optional folder argument: the self-test (scripts/guard-selftest.mjs) points the guard at a temp folder.
const dir = process.argv[2] ?? join(CATALOG, "palettes");
const hits = [];
let checked = 0;
for (const name of readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
  const path = join(dir, name);
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    for (const [, hex] of line.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      checked++;
      const theme = DENYLIST[hex.toLowerCase()];
      if (theme) hits.push(`${rel(path)}:${i + 1}: #${hex.toLowerCase()} is a ${theme} colour`);
    }
  });
}

if (checked === 0) {
  console.error("check-palettes: no hex values found in catalog/palettes (wrong folder?)");
  process.exit(1);
}
if (hits.length) {
  console.error(`check-palettes: ${hits.length} denylisted colour(s). Replace each with an original value:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-palettes: ${checked} colour value(s) checked, none on the denylist`);
