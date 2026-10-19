// Job C: browser click-through of the built site (dist/). Run in CI after `npm run build`.
// Playwright is installed only in CI (npm i --no-save playwright), not a repo dependency.
// Usage: node tests/e2e/wizard.e2e.mjs            (env: DIST=dist, SHOTS=e2e-shots, PORT=4173)
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { toPayload, toBase64 } from "../../site/src/generator.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.DIST ?? join(here, "..", "..", "dist"));
const SHOTS = resolve(process.env.SHOTS ?? join(here, "..", "..", "e2e-shots"));
const PORT = Number(process.env.PORT ?? 4173);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".sh": "text/plain" };

// Static server for dist/, so the test runs the same files as Pages.
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
});

let step = 0;
const failures = [];
async function shot(page, name) {
  step += 1;
  const file = join(SHOTS, `${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  shot ${file}`);
}
function check(cond, message) {
  if (cond) console.log(`  ok: ${message}`);
  else failures.push(message);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  await new Promise((r) => server.listen(PORT, r));
  const base = `http://localhost:${PORT}/`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const next = () => page.getByRole("button", { name: "Next", exact: true }).click();
  // Press Next until the named step heading shows. Optional add-on tools sit between Waybar and Review.
  async function toStep(name) {
    for (let i = 0; i < 15; i++) {
      if (await page.getByRole("heading", { name }).isVisible()) return;
      await next();
    }
    throw new Error(`step "${name}" never appeared`);
  }
  // The add-on tools come before Waybar (terminal, launcher). Skip them with Next until the Waybar page shows.
  const toWaybar = async () => {
    for (let i = 0; i < 6; i++) {
      const here = await page.getByRole("heading", { name: "Waybar" }).waitFor({ timeout: 1000 }).then(() => true, () => false);
      if (here) return;
      await next();
    }
  };

  // 1. Distro
  await page.goto(base);
  await page.getByRole("heading", { name: "Distro" }).waitFor();
  await page.getByRole("button", { name: "Use this" }).first().click();
  await shot(page, "distro");
  await next();

  // 2. Display system
  await page.getByRole("radio", { name: /Wayland/ }).check();
  await shot(page, "display");
  await next();

  // 3. Compositor: Sway
  await page.getByRole("button", { name: "Use this" }).first().click();
  // Sway tiers: portal and polkit are required (Included, no button); screenshots is recommended (Add); media keys is optional (no prompt).
  check(await page.getByText("Included: Desktop portal (needed because Sway)").isVisible(), "Sway shows the required portal as Included");
  check(await page.getByText("Included: Polkit agent (needed because Sway)").isVisible(), "Sway shows the required polkit agent as Included");
  const recommended = page.getByRole("listitem").filter({ hasText: "Also recommended: Screenshots" });
  check(await recommended.getByRole("button", { name: "Add" }).isVisible(), "Sway offers screenshots as Also recommended, with Add");
  check((await page.getByText("Volume and brightness keys").count()) === 0, "optional media keys are not prompted");
  await shot(page, "compositor");
  await recommended.getByRole("button", { name: "Add" }).click();
  check(await page.getByText("Screenshots (grim and slurp) is in your build").isVisible(), "accepted screenshots shows 'is in your build'");
  await next();

  // 4. Palette: pick a different palette; the swatch strip shows its colors
  await page.getByRole("heading", { name: "Palette" }).waitFor();
  const paletteRadios = page.locator("input[name=palette]");
  check((await paletteRadios.count()) >= 2, "palette step lists at least two palettes");
  await paletteRadios.nth(1).check();
  check((await page.locator(".swatches").first().locator(".swatch").count()) === 8, "the selected palette shows its 8 color swatches");
  await shot(page, "palette");
  await next();

  // 5. Font: Font Awesome only, so Waybar must ask for the Nerd Font
  await page.getByRole("radio", { name: /Font Awesome only/ }).check();
  await shot(page, "font");
  await next();

  // 5. Waybar: pick a variant, expect the Nerd Font prompt
  await toWaybar();
  await page.getByRole("heading", { name: "Waybar" }).waitFor();
  const variantCards = page.locator(".variant");
  const variantCount = await variantCards.count();
  check(variantCount === 5, `Waybar shows 5 variant cards (found ${variantCount})`);
  const imgs = page.locator(".variant img");
  for (let i = 0; i < (await imgs.count()); i++) {
    // Images are lazy-loaded, so scroll each one in and wait for it to finish loading.
    const ok = await imgs.nth(i).evaluate(async (img) => {
      img.scrollIntoView();
      if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
      return img.naturalWidth > 0;
    });
    check(ok, `variant screenshot ${i + 1} loaded`);
  }
  await variantCards.first().getByRole("button", { name: "Use this" }).click();
  check(await page.getByText("Also needs: Nerd Font", { exact: false }).isVisible(), "'Also needs: Nerd Font' appears with Font Awesome only");
  check(await page.locator(".badge[class*='needed-']").first().isVisible(), "needed badge is visible");
  check((await page.locator("ol.stepper li").count()) === 13, "stepper lists 13 steps: distro, display, compositor, palette, font, 5 tools, Sway settings, start method, review");
  await shot(page, "waybar-variant");
  await page.getByRole("listitem").filter({ hasText: "Also needs: Nerd Font" }).getByRole("button", { name: "Add" }).click();
  check(!(await page.getByText("Also needs: Nerd Font", { exact: false }).isVisible()), "Nerd Font prompt goes away after Add");
  await shot(page, "waybar-font-added");
  // Start method: pick auto-start on tty1, so the Save/Load round trip checks start_method too.
  await toStep("Start method");
  await page.getByRole("radio", { name: /Auto-start on the first console/ }).check();
  check(await page.getByRole("radio", { name: /Auto-start on the first console/ }).isChecked(), "tty1 start method is selectable");
  await shot(page, "start-method");
  await next();

  // 6. Review
  await page.getByRole("heading", { name: "Review" }).waitFor();
  const line = page.getByRole("textbox", { name: "Install command" });
  // The command is filled in after latest.json is read, so wait for it.
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Install command"]')?.value.startsWith("curl "), null, { timeout: 10000 });
  const oneLiner = await line.inputValue();
  // Local builds have no latest.json, so the Review page falls back to v1. A release build points at its tag.
  check(/\/(v1|v\d+\.\d+\.\d+(-rc\d+)?)\/install\.sh /.test(oneLiner), "one-liner uses a versioned install.sh folder");
  check(/ \| bash -s -- --build [A-Za-z0-9_-]+$/.test(oneLiner), "one-liner passes the build code with --build and no script");
  check(!oneLiner.includes("--script"), "one-liner does not use the old --script bootstrap");
  await page.getByText(/^sha256 of install\.sh: [0-9a-f]{64}$/).waitFor({ timeout: 10000 }).then(
    () => check(true, "Review shows the sha256 of install.sh"),
    () => check(false, "Review shows the sha256 of install.sh")
  );
  await shot(page, "review");

  // Save, then Start over, then Load: the same build comes back
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save build (.yaml)" }).click()]);
  const saved = join(SHOTS, "saved-build.yaml");
  await download.saveAs(saved);
  // Load is on the Review step, so start over and rebuild a different choice (Font Awesome only), then load.
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("heading", { name: "Distro" }).waitFor();
  await page.getByRole("button", { name: "Use this" }).first().click();
  await next();
  await page.getByRole("radio", { name: /Wayland/ }).check();
  await next();
  await page.getByRole("button", { name: "Use this" }).first().click();
  await next();
  await next();
  await page.getByRole("radio", { name: /Font Awesome only/ }).check();
  await next();
  await toWaybar();
  await page.getByRole("button", { name: "Use this" }).first().click();
  await toStep("Review");
  check((await page.getByRole("textbox", { name: "Install command" }).inputValue()) !== oneLiner, "rebuilt build differs before Load");
  await page.locator("#load-build").setInputFiles(saved);
  await page.getByRole("heading", { name: "Review" }).waitFor();
  const reloaded = await page.getByRole("textbox", { name: "Install command" }).inputValue();
  check(reloaded === oneLiner, "Save then Load restores the same build (same install command)");
  await shot(page, "loaded-build");

  // Old-version share link: must still open, with the notice
  const oldPayload = toPayload({ distro: "debian13", display: "wayland", font: "jetbrains-mono", choices: { sway: { variant: null }, waybar: { variant: "minimal" } } }, "0.0.1");
  const oldHash = `#build=${encodeURIComponent(toBase64(JSON.stringify(oldPayload)))}`;
  // The wizard reads the hash only at startup, so open the old link in a fresh page.
  const oldPage = await context.newPage();
  await oldPage.goto(base + oldHash);
  await oldPage.getByRole("heading", { name: "Review" }).waitFor();
  check(await oldPage.getByText("older catalog", { exact: false }).isVisible(), "old-version link shows the 'older catalog' notice");
  await oldPage.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-old-link-notice.png`), fullPage: true });

  await browser.close();
}

try {
  await main();
} catch (err) {
  failures.push(`exception: ${err.message}`);
} finally {
  server.close();
}

if (failures.length) {
  console.error(`e2e: ${failures.length} check(s) failed:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`e2e: all checks passed. Screenshots in ${SHOTS}`);
await writeFile(join(SHOTS, "README.txt"), "Step screenshots from tests/e2e/wizard.e2e.mjs, in order.\n");
