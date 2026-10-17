// Pure generator: wizard state + catalog -> install plan and install script.
// No DOM access, so the same code runs in the browser and in scripts/generate-install.mjs.
//
// State (in memory):
//   { distro: "debian13", display: "wayland", font: "jetbrains-mono", palette: "midnight",
//     extras: ["portal", "polkit", ...],
//     choices: { sway: { variant: null }, waybar: { variant: "minimal" } } }
// Only chosen tools appear in `choices`. A tool that is skipped is simply absent.
// `extras` lists the add-ons the user accepted ("Also needs" in the wizard).
//
// Payload (Save/Load YAML and share link). Only these fields, no timestamps or host info:
//   schema_version: 3
//   catalog_version: "0.1.0"
//   choices: { distro, display, font, palette, extras, tools: { <tool id>: { variant } } }
// Schema 2 (no palette/extras) and schema 1 (`deskwizard: 1`, flat choices) are still accepted.

const SAFE_PKG = /^[a-z0-9][a-z0-9.+-]*$/;
export const HEREDOC = "DESKWIZARD_EOF";
export const SCHEMA_VERSION = 3;
export const DEFAULT_PALETTE = "midnight";
export const NERD_FONT_TOKEN = "{{NERD_FONT}}";
// Packages every bar build adds on top of the bar's own list. Also used by scripts/list-packages.mjs.
export const BAR_EXTRA_PACKAGES = ["fontconfig", "curl", "xz-utils"];
// Largest base64 string that fits in one command-line argument (Linux MAX_ARG_STRLEN is 128 KiB).
export const MAX_ONE_LINE_BASE64 = 120000;
// Palette tokens in variant files: $bg, $accent2, $font_mono, and color forms $bg_hex (no #) and $bg_hexff (RRGGBBff).
const TOKEN_RE = /\$(font_ui|font_mono|[a-z][a-z0-9]*)(_hexff|_hex)?/g;
export const PALETTE_COLOR_TOKENS = ["bg", "surface", "fg", "muted", "accent", "accent2", "warn", "error"];
export const PALETTE_FONT_TOKENS = ["font_ui", "font_mono"];

function toolById(catalog, id) {
  return catalog.tools.find((t) => t.id === id);
}

export function fontById(catalog, id) {
  return catalog.fonts.fonts.find((f) => f.id === id);
}

export function paletteById(catalog, id) {
  return (catalog.palettes ?? []).find((p) => p.id === id);
}

function extraById(catalog, id) {
  return (catalog.extras ?? []).find((e) => e.id === id);
}

// Recommended extras of the chosen tools that the state has not accepted yet.
// Used by the wizard for "Also recommended: X [Add]". Required extras are never listed here: they are always included.
export function missingExtras(state, catalog) {
  const chosen = Object.keys(state?.choices ?? {}).map((id) => toolById(catalog, id)).filter(Boolean);
  const accepted = state?.extras ?? [];
  const missing = [];
  for (const tool of chosen) {
    for (const id of tool.recommends ?? []) {
      if (!accepted.includes(id) && !missing.includes(id)) missing.push(id);
    }
  }
  return missing;
}

// Replaces $tokens in a variant file with values from the palette.
// Returns { text, unknown }. `unknown` lists tokens the palette does not define.
export function resolveTokens(text, palette) {
  const unknown = [];
  const out = text.replace(TOKEN_RE, (match, name, suffix) => {
    if (name.startsWith("font_")) {
      const value = palette.tokens[name];
      if (value === undefined || suffix) {
        unknown.push(match);
        return match;
      }
      return value;
    }
    const value = palette.tokens[name];
    if (value === undefined || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      unknown.push(match);
      return match;
    }
    if (suffix === "_hex") return value.slice(1);
    if (suffix === "_hexff") return value.slice(1) + "ff";
    return value;
  });
  return { text: out, unknown };
}

// Returns { errors, chosen, distro, font, palette, extras }. `chosen` is the list of catalog tools in display order.
export function validateState(state, catalog) {
  const errors = [];
  const distro = catalog.distros.find((d) => d.id === state?.distro);
  if (!distro) errors.push(`Unknown distro '${state?.distro}'.`);
  else if (distro.status !== "available") errors.push(`${distro.name} is coming soon.`);

  if (state?.display !== "wayland") errors.push("Sway needs Wayland. Pick Wayland to continue.");

  const font = fontById(catalog, state?.font);
  if (!font) errors.push(`Unknown font '${state?.font}'. Pick one of the listed fonts.`);

  const palette = paletteById(catalog, state?.palette ?? DEFAULT_PALETTE);
  if (!palette) errors.push(`Unknown palette '${state?.palette}'. Pick one of the listed palettes.`);

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

  // Extras the user accepted, plus every extra the chosen tools need. A tool like Sway cannot
  // work without its portal and polkit agent, so those are always included in the build.
  const accepted = state?.extras ?? [];
  for (const id of accepted) {
    if (!extraById(catalog, id)) errors.push(`Unknown extra '${id}'.`);
  }
  const extras = [...accepted];
  for (const tool of chosen) {
    for (const id of tool.extras ?? []) if (!extras.includes(id)) extras.push(id);
  }

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
  return { errors, chosen, distro, font, palette, extras };
}

// Renders the key for the cheat sheet and for sway: "$mod+Return" -> "Super+Return".
function prettyKey(key) {
  return key.replaceAll("$mod", "Super");
}

// Builds the install plan. Never throws; returns { ok, errors, plan }.
export function buildPlan(state, catalog) {
  const { errors, chosen, distro, font, palette, extras } = validateState(state, catalog);
  const packages = [];
  const files = [];
  const binds = [];
  const autostart = [];
  const cheatsheet = [];
  const activeExtras = (extras ?? []).map((id) => extraById(catalog, id)).filter(Boolean);
  // Every extra in the plan: required by a chosen tool, or accepted by the user (recommended or added).
  const neededExtras = activeExtras;

  if (!errors.length) {
    for (const tool of chosen) {
      const list = tool.packages[distro.id];
      if (!list) {
        errors.push(`${tool.name} has no package list for ${distro.id}.`);
        continue;
      }
      for (const pkg of list) if (!packages.includes(pkg)) packages.push(pkg);
    }
    for (const extra of neededExtras) {
      for (const pkg of extra.packages[distro.id] ?? []) if (!packages.includes(pkg)) packages.push(pkg);
    }
  }

  const bars = chosen.filter((t) => t.type === "bar");
  // "Font Awesome only" has archive null and comes from apt (already in the bar's package list).
  const downloadFont = bars.length > 0 && Boolean(font) && font.archive !== null;
  if (bars.length > 0) {
    for (const pkg of BAR_EXTRA_PACKAGES) {
      // curl and xz-utils are only needed to download and unpack the Nerd Font archive.
      if ((pkg === "curl" || pkg === "xz-utils") && !downloadFont) continue;
      if (!packages.includes(pkg)) packages.push(pkg);
    }
  }

  // Keybinds and startup lines: from the chosen tools, then from the accepted extras.
  const bindSources = [...chosen.map((t) => ({ owner: t.id, items: t.binds ?? [] })), ...neededExtras.map((e) => ({ owner: e.id, items: e.binds ?? [] }))];
  for (const src of bindSources) {
    for (const b of src.items) {
      const dup = binds.find((x) => x.key === b.key);
      if (dup) {
        errors.push(`two features use the key ${b.key} (${dup.owner} and ${src.owner}).`);
        continue;
      }
      binds.push({ key: b.key, command: b.command, label: b.label ?? null, owner: src.owner });
      if (b.label) cheatsheet.push(`  ${prettyKey(b.key).padEnd(24)} ${b.label}`);
    }
  }
  for (const tool of chosen) for (const line of tool.autostart ?? []) autostart.push({ line, owner: tool.id });
  for (const extra of neededExtras) for (const line of extra.autostart ?? []) autostart.push({ line, owner: extra.id });

  if (!errors.length) {
    // Bar block for the Sway config: point Sway's bar at the chosen bar binary.
    const barBlock = bars.length
      ? `bar {\n    swaybar_command ${bars[0].command ?? bars[0].id}\n}`
      : "# No status bar selected. Sway starts without one.";
    const terminal = chosen.find((t) => t.type === "terminal");
    // Sway only treats # as a comment at the start of a line, so notes go on their own line.
    const termCmd = terminal?.command ?? "foot";
    const bindBlock = binds
      .map((b) => (b.label ? `# ${b.label}\n` : "") + `bindsym ${b.key} ${b.command}`)
      .join("\n");
    const execBlock =
      autostart.map((a) => `# started by ${a.owner}\nexec ${a.line}`).join("\n") || "# Nothing to start at login.";
    const subs = {
      "{{BAR_BLOCK}}": barBlock,
      "{{BINDS}}": bindBlock,
      "{{EXEC}}": execBlock,
      "{{TERM_CMD}}": termCmd,
    };
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
        let out = content;
        let binary = Boolean(item.binary);
        if (!binary) {
          // Palette tokens are resolved only in variant text files; the tool's own files use placeholders.
          if (item.from === "variant") {
            const res = resolveTokens(out, palette);
            if (res.unknown.length) errors.push(`${tool.name} '${variant?.id}': unknown token ${res.unknown.join(", ")}.`);
            out = res.text;
          }
          out = out.replaceAll(`"${NERD_FONT_TOKEN}", `, family);
          for (const [key, value] of Object.entries(subs)) out = out.replaceAll(key, value);
        }
        files.push({
          target,
          content: out,
          binary,
          from: `${tool.id}${variant ? "/" + variant.id : ""}`,
        });
      }
    }
  }

  for (const pkg of packages) {
    if (!SAFE_PKG.test(pkg)) errors.push(`package name '${pkg}' is not a valid apt name.`);
  }
  for (const f of files) {
    if (!f.binary && f.content.split("\n").some((line) => line === HEREDOC)) {
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
      palette: palette.id,
      downloadFont,
      bars: bars.map((b) => b.id),
      chosen: chosen.map((t) => t.id),
      binds,
      cheatsheet,
    },
  };
}

// Renders the installer from the template. `fonts` is catalog.fonts (font list, version, dest_root).
export function renderScript(plan, fonts, template) {
  const f = plan.font;
  const fileBlocks = plan.files
    .map((file) => {
      const target = file.target.replace(/^~\//, "$HOME/");
      if (file.binary) {
        // Binary files (wallpapers) are stored base64 in the catalog and decoded here.
        return `# ${file.from}\nbase64 -d <<'${HEREDOC}' | write_file "${target}"\n${file.content}\n${HEREDOC}\n`;
      }
      const body = file.content.endsWith("\n") ? file.content : file.content + "\n";
      return `# ${file.from}\nwrite_file "${target}" <<'${HEREDOC}'\n${body}${HEREDOC}\n`;
    })
    .join("\n");

  const cheat = plan.cheatsheet.length
    ? `cat <<'${HEREDOC}'\nYour keys (Super = the Windows key):\n${plan.cheatsheet.join("\n")}\n${HEREDOC}`
    : "# No keybinds in this build.";

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
    "# @@CHEATSHEET@@": cheat,
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
      palette: state.palette ?? DEFAULT_PALETTE,
      extras: [...(state.extras ?? [])],
      tools,
    },
  };
}

// Accepts schema 3, 2 and the legacy schema 1. Returns { state, notices }.
// `catalog` is optional; older payloads need it to find the extras their tools use.
// Throws a plain-language Error for anything else.
export function fromPayload(obj, currentCatalogVersion, catalog) {
  if (!obj || typeof obj !== "object") throw new Error("This is not a deskwizard build.");
  const notices = [];

  if (obj.schema_version === SCHEMA_VERSION || obj.schema_version === 2) {
    const c = obj.choices ?? {};
    if (typeof c !== "object") throw new Error("The build's choices are missing.");
    if (obj.catalog_version !== currentCatalogVersion) {
      notices.push(
        `This build was made with an older catalog (${obj.catalog_version ?? "unknown"}). ` +
          `The current catalog is ${currentCatalogVersion}. Check each choice on the Review step.`
      );
    }
    let extras = Array.isArray(c.extras) ? [...c.extras] : null;
    if (extras === null) {
      // Schema 2 had no extras: accept every extra the chosen tools use, as the old build did.
      extras = [];
      for (const id of Object.keys(c.tools ?? {})) {
        const tool = catalog ? toolById(catalog, id) : null;
        for (const e of tool?.extras ?? []) if (!extras.includes(e)) extras.push(e);
      }
      notices.push("This build was saved before palettes existed. The default palette was applied.");
    }
    return {
      state: {
        distro: c.distro ?? null,
        display: c.display ?? "wayland",
        font: c.font ?? null,
        palette: c.palette ?? DEFAULT_PALETTE,
        extras,
        choices: c.tools ?? {},
      },
      notices,
    };
  }

  if (obj.deskwizard === 1) {
    notices.push(
      "This build uses the older deskwizard format (schema 1). The font was set to the default. " +
        "Check the choices on the Review step."
    );
    return {
      state: {
        distro: obj.distro ?? null,
        display: obj.display ?? "wayland",
        font: null,
        palette: DEFAULT_PALETTE,
        extras: [],
        choices: obj.choices ?? {},
      },
      notices,
    };
  }

  throw new Error(`Unknown build format (schema_version ${obj.schema_version ?? "missing"}). Nothing was loaded.`);
}
