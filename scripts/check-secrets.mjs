// Fails if any file in the repo looks like it holds a secret.
// Checks file names (*password*, *secret*, *.pem) and contents ("sudo password").
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const NAME_PATTERNS = [/password/i, /secret/i, /\.pem$/i];
const CONTENT_PATTERNS = [/sudo password/i];
const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

// Lists the files to check: git's view when this is a checkout, otherwise a walk of the tree.
// The CI container has no git until its first apt step, and actions/checkout may not leave .git there.
function listFiles() {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else {
          out.push(relative(".", join(dir, entry.name)));
        }
      }
    };
    walk(".");
    return out;
  }
}

const files = listFiles().map((f) => f.replaceAll("\\", "/").replace(/^\.\//, ""));

const problems = [];
for (const file of files) {
  if (file === "scripts/check-secrets.mjs") continue; // this checker's own name matches the patterns
  if (NAME_PATTERNS.some((re) => re.test(file))) {
    problems.push(`${file}: file name looks like a secret`);
    continue;
  }
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8").split("\n");
  text.forEach((line, i) => {
    if (CONTENT_PATTERNS.some((re) => re.test(line))) {
      problems.push(`${file}:${i + 1}: contains a sudo password line`);
    }
  });
}

if (problems.length) {
  console.error(`check-secrets: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-secrets: OK (${files.length} files)`);
