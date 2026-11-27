#!/usr/bin/env node
// Creates catalog/tools/<id>/tool.yaml as a valid skeleton, then runs the validator.
// Every TODO in the file must be replaced by hand. If validation fails, the new folder is removed again.
// Run: npm run new-tool -- <id>
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, rel } from "./lib/load.mjs";
import { ID_RE, titleFromId, runValidate } from "./lib/scaffold.mjs";

const id = process.argv[2];
if (!id || !ID_RE.test(id)) {
  console.error("usage: npm run new-tool -- <id>   (id: lowercase letters, digits and dashes, starting with a letter)");
  process.exit(2);
}

const dir = join(CATALOG, "tools", id);
if (existsSync(dir)) {
  console.error(`new-tool: ${rel(dir)} already exists. Pick another id.`);
  process.exit(2);
}

const yaml = `# New tool skeleton. Replace every TODO, then run: npm run validate
id: ${id}
name: ${titleFromId(id)}
type: launcher # TODO: one of compositor, bar, terminal, launcher, notifications, wallpaper (bar and wallpaper need a variant)
description: TODO describe what this tool does for the user (at least 10 characters).
needed: optional # required | recommended | optional
needed_reason: TODO say why someone would want this (at least 5 characters).
display:
  order: 99 # TODO: position in the wizard
works_with:
  - sway
requires:
  - sway
extras: []
packages:
  debian13:
    - ${id} # TODO: confirm the Debian 13 package name with: apt-cache policy <name>
difficulty: easy # TODO: easy | medium | hard
ram_mb: 10 # TODO: measured or estimated resident memory in MB
default_variant: null # TODO: set to a variant id once you add one with npm run new-variant
command: ${id}
autostart: []
binds: []
install: []
`;

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "tool.yaml"), yaml);

const result = runValidate();
if (!result.ok) {
  rmSync(dir, { recursive: true, force: true });
  console.error(`new-tool: validation failed, removed ${rel(dir)}:\n${result.output}`);
  process.exit(1);
}
console.log(`new-tool: created ${rel(join(dir, "tool.yaml"))} and validation passes.`);
console.log("Next: replace the TODO lines, then add a variant with npm run new-variant -- " + id + " <id>");
