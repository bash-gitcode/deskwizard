// Runs the static installer (site/src/installer.sh) against a local copy of the built site/public/v1.
// Every rejection case must exit non-zero with a clear message and must not write anything under HOME.
// The tamper case needs the OS guard to pass (Debian 13), so it runs only there (CI runs it in debian:trixie).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(ROOT, "site", "src", "installer.sh");
const BUILT_V1 = join(ROOT, "site", "public", "v1");
const catalog = JSON.parse(readFileSync(join(ROOT, "site", "public", "catalog.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(BUILT_V1, "manifest.json"), "utf8"));

// Base64url of plain key=value lines, the same shape buildCode produces.
const encodeLines = (lines) => Buffer.from(lines.join("\n") + "\n", "utf8").toString("base64url");
function validLines(overrides = {}) {
  const base = {
    schema: "4",
    catalog: manifest.catalog_version,
    distro: "debian13",
    display: "wayland",
    font: catalog.fonts.default,
    palette: "midnight",
    start: "manual",
  };
  return Object.entries({ ...base, ...overrides }).map(([k, v]) => `${k}=${v}`);
}
const validCode = () => encodeLines(validLines());

// Serves a directory tree that holds v1/ at its top level.
function serve(siteDir) {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/v1\//, "");
      const file = join(siteDir, "v1", rel);
      if (!rel || rel.includes("..") || !existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => {
      resolveServer({ server, base: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

// A private copy of the built site that a test can change.
function copySite() {
  const dir = mkdtempSync(join(tmpdir(), "dw-site-"));
  cpSync(BUILT_V1, join(dir, "v1"), { recursive: true });
  return dir;
}

let good;
before(async () => {
  good = await serve(join(ROOT, "site", "public"));
});
after(() => good?.server.close());

function runInstaller(args, { home, base: siteBase = good.base } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("bash", [INSTALLER, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        DESKWIZARD_TEST_MODE: "1",
        DESKWIZARD_TEST_BASE_URL: siteBase,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("error", rejectRun);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, out });
    });
  });
}

const freshHome = () => mkdtempSync(join(tmpdir(), "dw-home-"));

// Lists every file under dir. Empty means the installer wrote nothing.
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function assertRejected(result, home, pattern) {
  assert.notEqual(result.status, 0, `installer should fail, output:\n${result.out}`);
  assert.match(result.out, pattern);
  assert.deepEqual(filesUnder(home), [], "installer must not write anything");
}

test("unknown id in the build code is rejected before anything is written", async () => {
  const home = freshHome();
  const code = encodeLines(validLines({ distro: "fedora" }));
  assertRejected(await runInstaller(["--build", code], { home }), home, /unknown distro 'fedora'/);
});

test("malformed build code (bad characters) is rejected", async () => {
  const home = freshHome();
  assertRejected(await runInstaller(["--build", "abc*def"], { home }), home, /malformed/);
});

test("oversized build code is rejected", async () => {
  const home = freshHome();
  assertRejected(await runInstaller(["--build", "A".repeat(4097)], { home }), home, /longer than 4096 characters/);
});

test("a build code line that is not in the schema is rejected", async () => {
  const home = freshHome();
  const code = encodeLines([...validLines(), "exec=rm -rf ~"]);
  assertRejected(await runInstaller(["--build", code], { home }), home, /malformed line/);
});

test("a build code with no start method is rejected", async () => {
  const home = freshHome();
  const lines = validLines().filter((l) => !l.startsWith("start="));
  assertRejected(await runInstaller(["--build", encodeLines(lines)], { home }), home, /missing 'start'/);
});

test("a tampered data file is rejected before anything is written (Debian 13 only)", async (t) => {
  const osRelease = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
  if (!/^ID=debian$/m.test(osRelease) || !/^VERSION_ID="?13"?$/m.test(osRelease)) {
    t.skip("needs Debian 13: the OS guard runs before any file is fetched. CI runs this in debian:trixie.");
    return;
  }
  const home = freshHome();
  const tampered = copySite();
  appendFileSync(join(tampered, "v1", "files", "fonts", `${catalog.fonts.default}.txt`), "tampered=1\n");
  const srv = await serve(tampered);
  try {
    assertRejected(
      await runInstaller(["--build", validCode()], { home, base: srv.base }),
      home,
      /checksum mismatch for files\/fonts\//
    );
  } finally {
    srv.server.close();
  }
});
