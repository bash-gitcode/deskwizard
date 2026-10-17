import { parse, stringify } from "yaml";
import template from "./installer.template.sh?raw";
import {
  buildPlan,
  renderScript,
  bootstrapCommand,
  fitsOneLine,
  toPayload,
  fromPayload,
  toBase64,
  fromBase64,
  fontById,
  paletteById,
  DEFAULT_PALETTE,
  PALETTE_COLOR_TOKENS,
} from "./generator.js";

const HASH_KEY = "build=";
const NEEDED_LABEL = { required: "Required", recommended: "Recommended", optional: "Optional" };
const INSTALLER_PATH = "v1/install.sh";

// ---- tiny DOM helper --------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "onclick" || key === "onchange") node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---- payload helpers --------------------------------------------------------
// Share link: #build=<base64 of the payload JSON>. Only choices and versions are stored.
function encodeBuild(state, catalogVersion) {
  return `#${HASH_KEY}${encodeURIComponent(toBase64(JSON.stringify(toPayload(state, catalogVersion))))}`;
}

function decodeBuild(hash, catalogVersion, catalog) {
  const prefix = `#${HASH_KEY}`;
  if (!hash.startsWith(prefix)) return null;
  const obj = JSON.parse(fromBase64(decodeURIComponent(hash.slice(prefix.length))));
  return fromPayload(obj, catalogVersion, catalog);
}

// Selecting a compositor replaces the other one. Selecting a tool sets its choice.
function setChoice(state, catalog, tool, variant) {
  if (tool.type === "compositor") {
    for (const other of catalog.tools) {
      if (other.type === "compositor" && other.id !== tool.id) delete state.choices[other.id];
    }
  }
  state.choices[tool.id] = { variant: variant ?? null };
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed. Select the text and copy it by hand.";
  }
  setTimeout(() => (button.textContent = original), 2000);
}

// ---- wizard -----------------------------------------------------------------
export function startWizard(root, catalog) {
  const catalogVersion = catalog.catalog_version;
  const toolName = (id) => catalog.tools.find((t) => t.id === id)?.name ?? id;
  const compositors = catalog.tools.filter((t) => t.type === "compositor");
  // Add-ons in the order the user picks them: terminal, launcher, bar, notifications, wallpaper.
  const addOns = catalog.tools.filter((t) => t.type !== "compositor").sort((a, b) => a.display.order - b.display.order);

  const steps = [
    { id: "distro", title: "Distro" },
    { id: "display", title: "Display system" },
    { id: "compositor", title: "Compositor" },
    { id: "palette", title: "Palette" },
    { id: "font", title: "Font" },
    ...addOns.map((tool) => ({ id: `tool:${tool.id}`, title: tool.name, tool })),
    { id: "review", title: "Review" },
  ];

  const freshState = () => ({ distro: null, display: "wayland", font: catalog.fonts.default, palette: DEFAULT_PALETTE, extras: [], choices: {} });
  // Fills a missing font, palette or extras list (older formats) with defaults, so every build has all three.
  const withDefaults = (state) => ({
    ...state,
    font: state.font ?? catalog.fonts.default,
    palette: state.palette ?? DEFAULT_PALETTE,
    extras: state.extras ?? [],
  });

  const app = { state: freshState(), index: 0, message: "", notices: [] };

  // A shared link or a saved build opens on Review and shows any notices about it.
  try {
    const loaded = decodeBuild(location.hash, catalogVersion, catalog);
    if (loaded) {
      app.state = withDefaults(loaded.state);
      app.notices = loaded.notices;
      app.index = steps.length - 1;
    }
  } catch (err) {
    app.message = `This link could not be read: ${err.message}`;
  }

  const current = () => steps[app.index];

  function canAdvance() {
    const step = current();
    if (step.id === "distro") return app.state.distro === "debian13";
    if (step.id === "display") return app.state.display === "wayland";
    if (step.id === "compositor") return compositors.some((c) => app.state.choices[c.id]);
    return true;
  }

  function sync(moved = false) {
    // Keep the URL hash in sync so the page can be shared or reloaded.
    history.replaceState(null, "", encodeBuild(app.state, catalogVersion));
    render(moved);
  }

  function go(index) {
    app.index = Math.max(0, Math.min(steps.length - 1, index));
    app.message = "";
    sync(true);
  }

  // ---- step renderers -----------------------------------------------------
  function distroStep() {
    return [
      el("p", {}, "Pick the distribution you run. Only Debian 13 “trixie” is supported right now."),
      el(
        "div",
        { class: "cards" },
        catalog.distros.map((d) => {
          const available = d.status === "available";
          const selected = app.state.distro === d.id;
          return el(
            "div",
            { class: `card${available ? "" : " muted"}` },
            el("h3", { text: d.name }),
            available
              ? el(
                  "button",
                  { type: "button", "aria-pressed": String(selected), onclick: () => { app.state.distro = d.id; sync(); } },
                  selected ? "Selected" : "Use this"
                )
              : el("p", { class: "badge" }, "Coming soon")
          );
        })
      ),
    ];
  }

  function displayStep() {
    const options = [
      {
        id: "wayland",
        name: "Wayland",
        text: "The newer display system. It draws each window on its own and is what Sway uses. Pick this one.",
      },
      {
        id: "x11",
        name: "X11",
        text: "The older display system that most desktops used for decades. Sway cannot run on it, so this build does not support it.",
      },
    ];
    return [
      el("p", {}, "The display system decides how windows are drawn on screen. It is a choice between old and new, not a matter of taste."),
      el(
        "fieldset",
        { class: "stack" },
        el("legend", {}, "Which display system?"),
        options.map((o) =>
          el(
            "label",
            { class: "option" },
            el("input", {
              type: "radio",
              name: "display",
              value: o.id,
              checked: app.state.display === o.id,
              onchange: () => { app.state.display = o.id; sync(); },
            }),
            el("span", {}, el("strong", { text: o.name }), el("span", { class: "explain", text: ` ${o.text}` }))
          )
        )
      ),
      app.state.display !== "wayland"
        ? el("p", { class: "warn", role: "alert" }, "Sway needs Wayland. Choose Wayland to continue.")
        : null,
    ];
  }

  function compositorStep() {
    return [
      el("p", {}, "The compositor draws your windows and manages the desktop. This build uses Sway: tiling windows driven from the keyboard."),
      el(
        "div",
        { class: "cards" },
        compositors.map((c) => {
          const selected = Boolean(app.state.choices[c.id]);
          return el(
            "div",
            { class: "card" },
            el("h3", { text: c.name }),
            el("p", {}, c.description),
            el("p", { class: "meta" }, `Difficulty: ${c.difficulty} · About ${c.ram_mb} MB RAM`),
            el(
              "button",
              {
                type: "button",
                "aria-pressed": String(selected),
                onclick: () => { setChoice(app.state, catalog, c, null); sync(); },
              },
              selected ? "Selected" : "Use this"
            )
          );
        })
      ),
      // The chosen compositor's own extras (portal and polkit are included; screenshots is offered).
      el(
        "ul",
        { class: "extras" },
        compositors.filter((c) => app.state.choices[c.id]).flatMap((c) => extrasPrompts(c))
      ),
    ];
  }

  // The font is one build-wide choice. Every option except "Font Awesome only" is downloaded
  // from the pinned Nerd Fonts release, and the installer checks its SHA-256 first.
  function fontStep() {
    return [
      el(
        "p",
        {},
        `Waybar uses this font for its text and icons. Nerd Font versions add many more icons. The downloads are pinned to Nerd Fonts ${catalog.fonts.version}.`
      ),
      el(
        "fieldset",
        { class: "stack" },
        el("legend", {}, "Which font?"),
        catalog.fonts.fonts.map((f) =>
          el(
            "label",
            { class: "option" },
            el("input", {
              type: "radio",
              name: "font",
              value: f.id,
              checked: app.state.font === f.id,
              onchange: () => { app.state.font = f.id; sync(); },
            }),
            el(
              "span",
              {},
              el("strong", { text: f.name }),
              el("span", {
                class: "explain",
                text: f.archive ? " Downloaded and checked with SHA-256." : " Installed from Debian's package. No download.",
              })
            )
          )
        )
      ),
    ];
  }

  // ---- palette --------------------------------------------------------------
  const currentPalette = () => paletteById(catalog, app.state.palette) ?? paletteById(catalog, DEFAULT_PALETTE);

  // Live strip of a palette's color tokens.
  function swatchStrip(p) {
    return el(
      "div",
      { class: "swatches", "aria-label": `Colors of ${p.name}` },
      PALETTE_COLOR_TOKENS.map((t) => el("span", { class: "swatch", title: `${t} ${p.tokens[t]}`, style: `background:${p.tokens[t]}` }))
    );
  }

  function paletteStep() {
    return [
      el("p", {}, "One palette colors the terminal, launcher, bar, notifications and wallpaper."),
      el(
        "fieldset",
        { class: "stack" },
        el("legend", {}, "Which palette?"),
        catalog.palettes.map((p) =>
          el(
            "label",
            { class: "option" },
            el("input", {
              type: "radio",
              name: "palette",
              value: p.id,
              checked: app.state.palette === p.id,
              onchange: () => { app.state.palette = p.id; sync(); },
            }),
            el("span", {}, el("strong", { text: p.name }), el("span", { class: "explain", text: ` ${p.mode} palette` })),
            swatchStrip(p)
          )
        )
      ),
      el("p", { class: "meta" }, "Screenshots use the default palette; your colors apply when installed."),
    ];
  }

  // Extras of a tool, in three tiers:
  //   required (tool.extras): always included, shown as "Included", no button;
  //   recommended (tool.recommends): "Also recommended" with an Add button;
  //   optional (anything else): no prompt.
  function extrasPrompts(tool) {
    const accepted = app.state.extras ?? [];
    const nameOf = (id) => catalog.extras.find((e) => e.id === id)?.name ?? id;
    const required = (tool.extras ?? []).map((id) =>
      el("li", { class: "ok" }, `Included: ${nameOf(id)} (needed because ${toolName(tool.id)})`)
    );
    const recommended = (tool.recommends ?? []).map((id) => {
      if (accepted.includes(id)) return el("li", { class: "ok" }, `✓ ${nameOf(id)} is in your build`);
      return el(
        "li",
        { class: "missing" },
        `Also recommended: ${nameOf(id)} `,
        el("button", { type: "button", onclick: () => { app.state.extras = [...accepted, id]; sync(); } }, "Add")
      );
    });
    return [...required, ...recommended];
  }

  // One page per add-on tool, all generated from its tool.yaml and variants.
  function toolStep(tool) {
    const choice = app.state.choices[tool.id];
    const chosen = Boolean(choice);
    const needed = NEEDED_LABEL[tool.needed] ?? tool.needed;
    const font = fontById(catalog, app.state.font);

    const requires = tool.requires.map((req) => {
      if (app.state.choices[req]) return el("li", { class: "ok" }, `✓ ${toolName(req)} is in your build`);
      const reqTool = catalog.tools.find((t) => t.id === req);
      return el(
        "li",
        { class: "missing" },
        `Also needs: ${toolName(req)} `,
        el(
          "button",
          {
            type: "button",
            onclick: () => {
              if (reqTool) setChoice(app.state, catalog, reqTool, reqTool.default_variant);
              sync();
            },
          },
          "Add"
        )
      );
    });

    requires.push(...extrasPrompts(tool));

    // Waybar's looks are designed for a Nerd Font. With "Font Awesome only" the icons fall back
    // to Font Awesome, so this is shown as a prompt, not a block.
    if (tool.type === "bar" && chosen && font && font.archive === null) {
      requires.push(
        el(
          "li",
          { class: "missing" },
          "Also needs: Nerd Font ",
          el(
            "button",
            {
              type: "button",
              onclick: () => { app.state.font = catalog.fonts.default; sync(); },
            },
            "Add"
          )
        )
      );
    }

    const variantCards = tool.variants.map((v) => {
      const selected = choice?.variant === v.id;
      return el(
        "article",
        { class: `card variant${selected ? " selected" : ""}` },
        el("img", {
          src: v.screenshot,
          alt: `Placeholder screenshot of the ${v.name} look`,
          width: 480,
          height: 240,
          loading: "lazy",
        }),
        el("h3", { text: v.name }),
        el("p", { class: "meta" }, "Good for: ", v.good_for.join(", ")),
        swatchStrip(currentPalette()),
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(selected),
            onclick: () => { setChoice(app.state, catalog, tool, v.id); sync(); },
          },
          selected ? "Selected" : "Use this"
        )
      );
    });

    return [
      el("p", { class: `badge needed-${tool.needed}` }, needed),
      el("p", {}, tool.needed_reason),
      el("p", {}, tool.description),
      el("p", { class: "meta" }, `Works with: ${tool.works_with.map(toolName).join(", ") || "anything"}`),
      el("p", { class: "meta" }, `Difficulty: ${tool.difficulty} · About ${tool.ram_mb} MB RAM`),
      requires.length ? el("ul", { class: "requires" }, requires) : null,
      tool.variants.length
        ? el(
            "section",
            { class: "variants" },
            el("h3", {}, "Pick a look"),
            el("div", { class: "cards" }, variantCards),
            el(
              "div",
              { class: "row" },
              el(
                "button",
                {
                  type: "button",
                  onclick: () => { setChoice(app.state, catalog, tool, tool.default_variant); sync(); },
                },
                "Default"
              ),
              el(
                "button",
                {
                  type: "button",
                  onclick: () => { delete app.state.choices[tool.id]; sync(); },
                },
                chosen ? "Remove from build" : "Skip"
              )
            )
          )
        : el(
            "div",
            { class: "row" },
            el(
              "button",
              {
                type: "button",
                onclick: () => { setChoice(app.state, catalog, tool, null); sync(); },
              },
              chosen ? "Remove from build" : "Add to build"
            )
          ),
    ];
  }

  // ---- review -------------------------------------------------------------
  function reviewStep() {
    const { ok, errors, plan } = buildPlan(app.state, catalog);
    if (!ok) {
      return [
        el("p", { class: "warn", role: "alert" }, "This build cannot be installed yet:"),
        el("ul", {}, errors.map((e) => el("li", {}, e))),
      ];
    }

    const script = renderScript(plan, catalog.fonts, template);
    const installerUrl = new URL(INSTALLER_PATH, location.href).href;
    const line = bootstrapCommand(installerUrl, script);
    const shareUrl = `${location.origin}${location.pathname}${encodeBuild(app.state, catalogVersion)}`;
    const fileName = "deskwizard-build.yaml";

    const copyBtn = el("button", { type: "button" }, "Copy install command");
    copyBtn.addEventListener("click", () => copyText(line, copyBtn));
    const shareBtn = el("button", { type: "button" }, "Copy share link");
    shareBtn.addEventListener("click", () => copyText(shareUrl, shareBtn));

    const loadInput = el("input", { type: "file", accept: ".yaml,.yml", id: "load-build" });
    loadInput.addEventListener("change", async () => {
      const file = loadInput.files?.[0];
      if (!file) return;
      try {
        const loaded = fromPayload(parse(await file.text()), catalogVersion, catalog);
        app.state = withDefaults(loaded.state);
        app.notices = loaded.notices;
        app.index = steps.length - 1;
        app.message = "Build loaded.";
        sync(true);
      } catch (err) {
        app.message = `Could not load that file: ${err.message}`;
        render();
      }
    });

    const fits = fitsOneLine(script);
    return [
      el("h3", {}, "Install command"),
      el("p", {}, "Run this in a terminal on Debian 13. It downloads the installer, checks it, and runs this build. Try --dry-run first if you like."),
      fits
        ? el("textarea", { readonly: true, rows: 3, "aria-label": "Install command", value: line })
        : el("p", { class: "warn", role: "alert" }, "This build is too large for a one-line command. Download install.sh and run it with bash."),
      el(
        "div",
        { class: "row" },
        fits ? copyBtn : null,
        el("button", { type: "button", onclick: () => download("install.sh", script, "text/x-shellscript") }, "Download install.sh")
      ),

      el("h3", {}, "Packages"),
      el("ul", { class: "mono" }, plan.packages.map((p) => el("li", {}, p))),

      el("h3", {}, "Keybinds"),
      el("pre", { class: "script" }, plan.cheatsheet.length ? plan.cheatsheet.join("\n") : "No keybinds in this build."),

      el("h3", {}, "Files to be written"),
      el("ul", { class: "mono" }, plan.files.map((f) => el("li", {}, `${f.target}  (${f.from})`))),
      el("p", { class: "meta" }, `Font: ${plan.font.name}${plan.downloadFont ? " (downloaded, SHA-256 checked)" : ""}. Existing files are copied to ~/.config-backup/<timestamp>/ first.`),

      el("details", {}, el("summary", {}, "Script preview"), el("pre", { class: "script" }, script)),

      el("h3", {}, "Keep this build"),
      el("div", { class: "row" }, shareBtn, el("button", { type: "button", onclick: () => download(fileName, stringify(toPayload(app.state, catalogVersion)), "text/yaml") }, "Save build (.yaml)")),
      el("p", { class: "meta" }, "Share link: ", el("code", { class: "wrap" }, shareUrl)),
      el("label", {}, "Load a saved build: ", loadInput),
      el(
        "button",
        {
          type: "button",
          onclick: () => {
            app.state = freshState();
            app.notices = [];
            app.index = 0;
            sync();
          },
        },
        "Start over"
      ),
    ];
  }

  // ---- layout -------------------------------------------------------------
  // Focus moves to the step heading only when the step changes, so in-step clicks keep keyboard position.
  function render(moved = false) {
    const step = current();
    const isReview = step.id === "review";
    const body = {
      distro: distroStep,
      display: displayStep,
      compositor: compositorStep,
      palette: paletteStep,
      font: fontStep,
      review: reviewStep,
    }[step.id];
    const content = body ? body() : toolStep(step.tool);

    const heading = el("h2", { tabindex: "-1", id: "step-heading" }, step.title);
    const stepper = el(
      "ol",
      { class: "stepper", "aria-label": "Steps" },
      steps.map((s, i) =>
        el(
          "li",
          {
            class: i === app.index ? "current" : i < app.index ? "done" : "",
            "aria-current": i === app.index ? "step" : null,
          },
          el(
            "button",
            { type: "button", onclick: () => { if (i <= app.index || canAdvance()) go(i); } },
            `${i + 1}. ${s.title}`
          )
        )
      )
    );

    const nav = el(
      "nav",
      { class: "nav" },
      el("button", { type: "button", disabled: app.index === 0, onclick: () => go(app.index - 1) }, "Back"),
      isReview ? null : el("button", { type: "button", class: "primary", disabled: !canAdvance(), onclick: () => go(app.index + 1) }, "Next")
    );

    const notices = app.notices.map((n) => el("p", { class: "notice", role: "note" }, n));

    root.replaceChildren(
      el("section", { class: "wizard" }, notices, stepper, el("div", { class: "step" }, heading, content), app.message ? el("p", { role: "status" }, app.message) : null, nav)
    );
    if (moved) heading.focus();
  }

  render();
}
