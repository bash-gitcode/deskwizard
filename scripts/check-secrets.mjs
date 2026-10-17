// Fails if any file in the repo looks like it holds a secret.
// Checks file names (*password*, *secret*, *.pem) and contents ("sudo password").
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const NAME_PATTERNS = [/password/i, /secret/i, /\.pem$/i];
const CONTENT_PATTERNS = [/sudo password/i];

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

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
