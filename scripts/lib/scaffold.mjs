// Helpers shared by scripts/new-tool.mjs and scripts/new-variant.mjs.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./load.mjs";

// Same rule as the schemas: lowercase, starts with a letter, letters/digits/dashes.
export const ID_RE = /^[a-z][a-z0-9-]*$/;

export function titleFromId(id) {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Runs the full validator. Returns { ok, output } so the caller can roll back on failure.
export function runValidate() {
  try {
    const output = execFileSync(process.execPath, [join(ROOT, "scripts", "validate.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
