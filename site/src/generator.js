// Pure generator: wizard state + catalog -> install plan and install script.
// No DOM access, so the same code runs in the browser and in scripts/generate-install.mjs.
//
// State (in memory):
//   { distro: "debian13", display: "wayland", font: "jetbrains-mono",
//     choices: { sway: { variant: null }, waybar: { variant: "minimal" } } }
// Only chosen tools appear in `choices`. A tool that is skipped is simply absent.
//
// Payload (Save/Load YAML and share link). Only these fields, no timestamps or host info:
//   schema_version: 2
//   catalog_version: "0.1.0"
//   choices: { distro, display, font, tools: { <tool id>: { variant } } }
// Schema 1 (`deskwizard: 1`, flat choices) is still accepted so older links resolve.

const SAFE_PKG = /^[a-z0-9][a-z0-9.+-]*$/;
export const HEREDOC = "DESKWIZARD_EOF";
export const SCHEMA_VERSION = 2;
export const NERD_FONT_TOKEN = "{{NERD_FONT}}";
// Packages every bar build adds on top of the bar's own list. Also used by scripts/list-packages.mjs.
export const BAR_EXTRA_PACKAGES = ["fontconfig", "curl"];
// Largest base64 string that fits in one command-line argument (Linux MAX_ARG_STRLEN is 128 KiB).
export const MAX_ONE_LINE_BASE64 = 120000;

function toolById(catalog, id) {
  return catalog.tools.find((t) => t.id === id);
}

export function fontById(catalog, id) {
  return catalog.fonts.fonts.find((f) => f.id === id);
}

// Returns { errors, chosen, distro, font }. `chosen` is the list of catalog tools in display order.
export function validateState(state, catalog) {
  const errors = [];
  const distro = catalog.distros.find((d) => d.id === state?.distro);
  if (!distro) errors.push(`Unknown distro '${state?.distro}'.`);
  else if (distro.status !== "available") errors.push(`${distro.name} is coming soon.`);

  if (state?.display !== "wayland") errors.push("Sway needs Wayland. Pick Wayland to continue.");

  const font = fontById(catalog, state?.font);
  if (!font) errors.push(`Unknown font '${state?.font}'. Pick one of the listed fonts.`);

  const choices = state?.choices ?? {};
  const chosen = [];
  for (const id of Object.keys(choices)) {
    const tool = toolById(catalog, id);
    if (!tool) {
      errors.push(`Unknown tool '${id}'.`);
      continue;
    }
    chosen.push(tool);
  }
  chosen.sort((a, b) => a.display.order - b.display.order);

  const compositors = chosen.filter((t) => t.type === "compositor");
  if (compositors.length !== 1) errors.push("Choose exactly one compositor (Sway).");

  for (const tool of chosen) {
    for (const req of tool.requires) {
      if (!choices[req]) errors.push(`${tool.name} needs ${req}. Add it to the build.`);
    }
    const variant = choices[tool.id]?.variant ?? null;
    if (tool.variants.length > 0) {
      const picked = tool.variants.find((v) => v.id === variant);
      if (!picked) {
        errors.push(`${tool.name}: pick a look (variant).`);
        continue;
      }
      for (const req of picked.requires ?? []) {
        if (!choices[req]) errors.push(`${tool.name} '${picked.name}' needs ${req}. Add it to the build.`);
      }
    }
  }
  return { errors, chosen, distro, font };
}

// Builds the install plan. Never throws; returns { ok, errors, plan }.
export function buildPlan(state, catalog) {
  const { errors, chosen, distro, font } = validateState(state, catalog);
  const packages = [];
  const files = [];

  if (!errors.length) {
    for (const tool of chosen) {
      const list = tool.packages[distro.id];
      if (!list) {
        errors.push(`${tool.name} has no package list for ${distro.id}.`);
        continue;
      }
      for (const pkg of list) if (!packages.includes(pkg)) packages.push(pkg);
    }
  }

  const bars = chosen.filter((t) => t.type === "bar");
  // "Font Awesome only" has archive null and comes from apt (already in the bar's package list).
  const downloadFont = bars.length > 0 && Boolean(font) && font.archive !== null;
  if (bars.length > 0) {
    for (const pkg of BAR_EXTRA_PACKAGES) {
      if (pkg === "curl" && !downloadFont) continue;
      if (!packages.includes(pkg)) packages.push(pkg);
    }
  }

  if (!errors.length) {
    // Bar block for the Sway config: point Sway's bar at the chosen bar binary.
    const barBlock = bars.length
      ? `bar {\n    swaybar_command ${bars[0].id}\n}`
      : "# No status bar selected. Sway starts without one.";
    const family = font.family ? `"${font.family}", ` : "";

    for (const tool of chosen) {
      const variant = tool.variants.find((v) => v.id === (state.choices[tool.id]?.variant ?? null)) ?? null;
      for (const item of tool.install) {
        let content;
        if (item.from === "tool") content = tool.files[item.source];
        else content = variant?.files[item.source];
        if (content === undefined) {
          errors.push(`${tool.name}: missing install source '${item.source}'.`);
          continue;
        }
        const target = item.target;
        if (files.some((f) => f.target === target)) {
          errors.push(`two selected tools write the same file: ${target}.`);
          continue;
        }
        files.push({
          target,
          content: content.replaceAll("{{BAR_BLOCK}}", barBlock).replaceAll(`"${NERD_FONT_TOKEN}", `, family),
          from: `${tool.id}${variant ? "/" + variant.id : ""}`,
        });
      }
    }
  }

  for (const pkg of packages) {
    if (!SAFE_PKG.test(pkg)) errors.push(`package name '${pkg}' is not a valid apt name.`);
  }
  for (const f of files) {
    if (f.content.split("\n").some((line) => line === HEREDOC)) {
      errors.push(`file ${f.target} contains the reserved line ${HEREDOC}.`);
    }
  }

  if (errors.length) return { ok: false, errors, plan: null };
  return {
    ok: true,
    errors: [],
    plan: {
      distro,
      packages,
      files,
      font,
      downloadFont,
      bars: bars.map((b) => b.id),
      chosen: chosen.map((t) => t.id),
    },
  };
}

// Renders the installer from the template. `fonts` is catalog.fonts (font list, version, dest_root).
export function renderScript(plan, fonts, template) {
  const f = plan.font;
  const fileBlocks = plan.files
    .map((file) => {
      const target = file.target.replace(/^~\//, "$HOME/");
      const body = file.content.endsWith("\n") ? file.content : file.content + "\n";
      return `# ${file.from}\nwrite_file "${target}" <<'${HEREDOC}'\n${body}${HEREDOC}\n`;
    })
    .join("\n");

  const destRoot = fonts.dest_root.replace(/^~\//, "$HOME/");
  const subs = {
    "@@PACKAGES@@": plan.packages.join(" "),
    "@@INSTALL_FONT@@": plan.downloadFont ? "true" : "false",
    "@@FONT_NAME@@": f.name,
    "@@FONT_VERSION@@": fonts.version,
    "@@FONT_ARCHIVE@@": f.archive ?? "",
    "@@FONT_SHA256@@": f.sha256 ?? "",
    "@@FONT_DEST@@": f.dest ? `${destRoot}/${f.dest}` : "",
    "@@FONT_FALLBACK@@": f.fallback_package,
    "# @@FILES@@": fileBlocks,
  };
  let out = template;
  for (const [key, value] of Object.entries(subs)) out = out.split(key).join(value);
  return out;
}

// ---- base64 (UTF-8 safe) ---------------------------------------------------
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---- one-line install -------------------------------------------------------
// The one-liner downloads the versioned bootstrap (/v1/install.sh) and passes this build's
// script to it with --script, so the same served installer can run any build.
export function bootstrapCommand(installerUrl, script) {
  return `curl -fsSL '${installerUrl}' | bash -s -- --script ${toBase64(script)}`;
}

// True when the one-line command would be too long for a single argument.
export function fitsOneLine(script) {
  return toBase64(script).length <= MAX_ONE_LINE_BASE64;
}

// ---- build payload (Save/Load and share link) -------------------------------
export function toPayload(state, catalogVersion) {
  const tools = {};
  for (const [id, choice] of Object.entries(state.choices ?? {})) tools[id] = { variant: choice?.variant ?? null };
  return {
    schema_version: SCHEMA_VERSION,
    catalog_version: catalogVersion,
    choices: {
      distro: state.distro,
      display: state.display,
      font: state.font,
      tools,
    },
  };
}

// Accepts schema 2 and the legacy schema 1. Returns { state, notices }.
// Throws a plain-language Error for anything else.
export function fromPayload(obj, currentCatalogVersion) {
  if (!obj || typeof obj !== "object") throw new Error("This is not a deskwizard build.");
  const notices = [];

  if (obj.schema_version === SCHEMA_VERSION) {
    const c = obj.choices ?? {};
    if (typeof c !== "object") throw new Error("The build's choices are missing.");
    if (obj.catalog_version !== currentCatalogVersion) {
      notices.push(
        `This build was made with an older catalog (${obj.catalog_version ?? "unknown"}). ` +
          `The current catalog is ${currentCatalogVersion}. Check each choice on the Review step.`
      );
    }
    return {
      state: { distro: c.distro ?? null, display: c.display ?? "wayland", font: c.font ?? null, choices: c.tools ?? {} },
      notices,
    };
  }

  if (obj.deskwizard === 1) {
    notices.push(
      "This build uses the older deskwizard format (schema 1). The font was set to the default. " +
        "Check the choices on the Review step."
    );
    return {
      state: { distro: obj.distro ?? null, display: obj.display ?? "wayland", font: null, choices: obj.choices ?? {} },
      notices,
    };
  }

  throw new Error(`Unknown build format (schema_version ${obj.schema_version ?? "missing"}). Nothing was loaded.`);
}
