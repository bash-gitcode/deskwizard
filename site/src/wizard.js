import { parse, stringify } from "yaml";
import installerSource from "./installer.sh?raw";
import {
  buildPlan,
  buildCode,
  toPayload,
  fromPayload,
  toBase64,
  fromBase64,
  fontById,
  paletteById,
  DEFAULT_PALETTE,
  DEFAULT_START,
  MAX_CODE_LENGTH,
  PALETTE_COLOR_TOKENS,
  stateFromBase,
  isCustomized,
} from "./generator.js";

const HASH_KEY = "build=";
const NEEDED_LABEL = { required: "Required", recommended: "Recommended", optional: "Optional" };
const SCREENSHOT_NOTE = "Screenshots use the default palette and sample values for hardware that CI does not have.";
// Folder of the installer the Review page links to: the latest stable release tag (written by the Pages build),
// or v1 (latest compatible) when no release exists yet.
const latestDir = fetch("latest.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => (j && typeof j.latest === "string" && /^v[0-9][0-9A-Za-z.+-]*$/.test(j.latest) ? j.latest : "v1"))
  .catch(() => "v1");

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

// ---- scene viewer -----------------------------------------------------------
// One scene image at a time in a native <dialog> (Esc closes it). The arrow keys and the buttons move through the
// list the image was opened from: a tool's looks, or all the bases.
let viewer = null;
let viewerItems = [];
let viewerIndex = 0;

function showScene() {
  const item = viewerItems[viewerIndex];
  viewer.querySelector("img").src = item.src;
  viewer.querySelector("img").alt = item.alt;
  viewer.querySelector("figcaption").textContent = item.caption;
  viewer.querySelector(".viewer-count").textContent = `${viewerIndex + 1} of ${viewerItems.length}`;
}

function moveScene(delta) {
  viewerIndex = (viewerIndex + delta + viewerItems.length) % viewerItems.length;
  showScene();
}

function openViewer(items, index) {
  if (!viewer) {
    viewer = el(
      "dialog",
      { class: "viewer", "aria-label": "Scene viewer" },
      el("figure", {}, el("img", { alt: "" }), el("figcaption", {})),
      el(
        "div",
        { class: "viewer-controls" },
        el("button", { type: "button", onclick: () => moveScene(-1) }, "Previous"),
        el("span", { class: "viewer-count", "aria-live": "polite" }),
        el("button", { type: "button", onclick: () => moveScene(1) }, "Next"),
        el("button", { type: "button", onclick: () => viewer.close() }, "Close")
      )
    );
    viewer.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        moveScene(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        moveScene(1);
      }
    });
    // A click outside the dialog's content (on the backdrop) closes it.
    viewer.addEventListener("click", (e) => {
      if (e.target === viewer) viewer.close();
    });
    document.body.append(viewer);
  }
  viewerItems = items;
  viewerIndex = index;
  showScene();
  viewer.showModal();
}

function baseScene(base) {
  return { src: base.image, alt: base.image_alt, caption: base.name };
}

function variantScene(tool, variant) {
  return { src: variant.screenshot, alt: variant.screenshot_alt, caption: `${tool.name}: ${variant.name}` };
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
    { id: "begin", title: "Start" },
    { id: "distro", title: "Distro" },
    { id: "display", title: "Display system" },
    { id: "compositor", title: "Compositor" },
    { id: "palette", title: "Palette" },
    { id: "font", title: "Font" },
    ...addOns.map((tool) => ({ id: `tool:${tool.id}`, title: tool.name, tool })),
    // Settings for a tool, e.g. "Sway settings". Shown for each compositor that declares options.
    ...compositors.filter((t) => t.options?.length).map((tool) => ({ id: `options:${tool.id}`, title: `${tool.name} settings`, tool })),
    { id: "start", title: "Start method" },
    { id: "review", title: "Review" },
  ];

  const freshState = () => ({ distro: null, display: "wayland", font: catalog.fonts.default, palette: DEFAULT_PALETTE, start: DEFAULT_START, extras: [], choices: {}, options: {} });
  // Fills a missing font, palette or extras list (older formats) with defaults, so every build has all three.
  const withDefaults = (state) => ({
    ...state,
    font: state.font ?? catalog.fonts.default,
    palette: state.palette ?? DEFAULT_PALETTE,
    extras: state.extras ?? [],
    start: state.start ?? DEFAULT_START,
    options: state.options ?? {},
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
  // Quick install, a base, or a blank build. A base fills every later step; the user can change any of them.
  function beginStep() {
    const bases = catalog.bases ?? [];
    const quick = bases[0];
    return [
      el("p", {}, "Pick how to start. Every choice can be changed on the next steps."),
      el(
        "div",
        { class: "cards" },
        el(
          "div",
          { class: "card" },
          el("h3", {}, "Quick install"),
          quick ? el("p", {}, `${quick.name}: ${quick.description}`) : null,
          quick
            ? el("button", { type: "button", class: "primary", onclick: () => { app.state = stateFromBase(quick); app.notices = []; go(steps.length - 1); } }, "Use Quick install")
            : null
        ),
        el(
          "div",
          { class: "card" },
          el("h3", {}, "Build your own"),
          el("p", {}, "Choose every step yourself, starting from nothing."),
          el("button", { type: "button", onclick: () => { app.state = freshState(); app.notices = []; go(1); } }, "Start a blank build")
        )
      ),
      el("h3", {}, "Pick a base"),
      el("p", { class: "meta" }, SCREENSHOT_NOTE),
      el(
        "div",
        { class: "cards" },
        bases.map((base, i) =>
          el(
            "div",
            { class: "card" },
            el(
              "button",
              {
                type: "button",
                class: "shot",
                "aria-label": `Enlarge the ${base.name} scene`,
                onclick: () => openViewer(bases.map(baseScene), i),
              },
              el("img", { src: base.image, alt: base.image_alt, width: 1920, height: 1080, loading: "lazy" })
            ),
            el("h3", {}, base.name),
            el("p", {}, base.description),
            el("button", { type: "button", onclick: () => { app.state = stateFromBase(base); app.notices = []; go(1); } }, `Use ${base.name}`)
          )
        )
      ),
    ];
  }

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

    const variantCards = tool.variants.map((v, i) => {
      const selected = choice?.variant === v.id;
      return el(
        "article",
        { class: `card variant${selected ? " selected" : ""}` },
        el(
          "button",
          {
            type: "button",
            class: "shot",
            "aria-label": `Enlarge the ${v.name} look`,
            onclick: () => openViewer(tool.variants.map((x) => variantScene(tool, x)), i),
          },
          el("img", { src: v.screenshot, alt: v.screenshot_alt, width: 480, height: 240, loading: "lazy" })
        ),
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
            el("p", { class: "meta" }, SCREENSHOT_NOTE),
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
  // Start method: how Sway starts after the install. Manual is the default.
  function startStep() {
    return [
      el("p", {}, "Choose how Sway starts after the install."),
      el(
        "fieldset",
        { class: "stack" },
        el("legend", {}, "How should the desktop start?"),
        catalog.start_methods.map((s) =>
          el(
            "label",
            { class: "option" },
            el("input", {
              type: "radio",
              name: "start",
              value: s.id,
              checked: (app.state.start ?? DEFAULT_START) === s.id,
              onchange: () => { app.state.start = s.id; sync(); },
            }),
            el("span", {}, el("strong", { text: s.name }), el("span", { class: "explain", text: ` ${s.summary}` }))
          )
        )
      ),
    ];
  }

  // One control per option the tool declares. Defaults are preselected; only values that differ from the default are kept.
  function optionsStep(tool) {
    if (!app.state.choices[tool.id]) {
      return [el("p", { class: "warn", role: "alert" }, `Choose ${tool.name} on the Compositor step first. Its settings are used only when it is chosen.`)];
    }
    const stored = app.state.options?.[tool.id] ?? {};
    const setValue = (def, value) => {
      app.state.options ??= {};
      const obj = (app.state.options[tool.id] ??= {});
      if (value === def.default) delete obj[def.key];
      else obj[def.key] = value;
      if (Object.keys(obj).length === 0) delete app.state.options[tool.id];
      sync();
    };
    const control = (def) => {
      const current = stored[def.key] ?? def.default;
      if (def.type === "bool") {
        return el("input", {
          type: "checkbox",
          checked: current === true,
          onchange: (e) => setValue(def, e.target.checked),
        });
      }
      if (def.type === "number") {
        return el("input", {
          type: "number",
          min: def.min,
          max: def.max,
          step: 1,
          value: current,
          onchange: (e) => {
            const raw = e.target.value.trim();
            // Whole numbers are stored as numbers. Anything else is kept as typed, and the Review step reports it.
            setValue(def, /^[0-9]+$/.test(raw) ? Number(raw) : raw);
          },
        });
      }
      const pattern = new RegExp(def.pattern);
      const field = el("input", {
        type: "text",
        value: current,
        onchange: (e) => setValue(def, e.target.value.trim()),
      });
      const hint = el("p", { class: "meta", role: "status" }, "");
      field.addEventListener("input", () => {
        hint.textContent = pattern.test(field.value.trim()) ? "" : "This value is not allowed. Example: us or us,de.";
      });
      return el("span", {}, field, hint);
    };
    return [
      el("p", {}, `Settings for ${tool.name}. The defaults are selected. Change only what you need.`),
      el(
        "ul",
        { class: "extras" },
        tool.options.map((def) =>
          el("li", {}, el("label", { class: "option" }, el("span", { text: def.label }), " ", control(def)))
        )
      ),
    ];
  }

  function reviewStep() {
    const { ok, errors, plan } = buildPlan(app.state, catalog);
    if (!ok) {
      return [
        el("p", { class: "warn", role: "alert" }, "This build cannot be installed yet:"),
        el("ul", {}, errors.map((e) => el("li", {}, e))),
      ];
    }

    const code = buildCode(app.state, catalogVersion);
    // The line is filled in once the latest release folder is known (see latestDir above).
    const fits = code.length <= MAX_CODE_LENGTH;
    const commandOut = el("textarea", { readonly: true, rows: 3, "aria-label": "Install command", value: "loading..." });
    const shaOut = el("code", { class: "wrap" }, "loading...");
    let line = "";
    latestDir.then((dir) => {
      const installerUrl = new URL(`${dir}/install.sh`, location.href).href;
      line = `curl -fsSL ${installerUrl} | bash -s -- --build ${code}`;
      commandOut.value = line;
      return fetch(`${dir}/install.sh.sha256`);
    })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((t) => { shaOut.textContent = t.split(" ")[0]; })
      .catch(() => { shaOut.textContent = "not available (run npm run build)"; });
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

    return [
      el("h3", {}, "Install command"),
      el("p", {}, "Run this in a terminal on Debian 13. It downloads the installer and runs this build. Add --dry-run at the end to print every step without changing anything."),
      fits
        ? commandOut
        : el("p", { class: "warn", role: "alert" }, `This build code is longer than ${MAX_CODE_LENGTH} characters, so the installer will refuse it. Choose fewer options.`),
      el(
        "div",
        { class: "row" },
        fits ? copyBtn : null,
        el("button", { type: "button", onclick: () =>
            latestDir
              .then((dir) => fetch(`${dir}/install.sh`))
              .then((r) => {
                if (!r.ok) throw new Error(String(r.status));
                return r.text();
              })
              .then((t) => download("install.sh", t, "text/x-shellscript"))
              .catch(() => { app.message = "Could not download install.sh (run npm run build)."; render(); }) },
          "Download install.sh")
      ),
      el("p", { class: "meta" }, "sha256 of install.sh: ", shaOut),
      el("pre", { class: "script" }, "sha256sum install.sh   # prints the same sha256 as above"),

      el("h3", {}, "Packages"),
      el("ul", { class: "mono" }, plan.packages.map((p) => el("li", {}, p))),

      el("h3", {}, "Keybinds"),
      el("pre", { class: "script" }, plan.cheatsheet.length ? plan.cheatsheet.join("\n") : "No keybinds in this build."),

      el("h3", {}, "Files to be written"),
      el("ul", { class: "mono" }, plan.files.map((f) => el("li", {}, `${f.target}  (${f.from})`))),
      el("p", { class: "meta" }, `Font: ${plan.font.name}${plan.downloadFont ? " (downloaded, SHA-256 checked)" : ""}. Existing files are copied to ~/.config-backup/<timestamp>/ first.`),
      el("p", { class: "meta" }, `Start method: ${plan.startSummary}`),

      el("details", {}, el("summary", {}, "Installer preview (install.sh source; the published copy sets SITE_BASE to its own folder)"), el("pre", { class: "script" }, installerSource)),

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
    const hideNext = isReview || step.id === "begin";
    const body = {
      begin: beginStep,
      distro: distroStep,
      display: displayStep,
      compositor: compositorStep,
      palette: paletteStep,
      font: fontStep,
      start: startStep,
      review: reviewStep,
    }[step.id];
    const content = body ? body() : step.id.startsWith("options:") ? optionsStep(step.tool) : toolStep(step.tool);

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
      hideNext ? null : el("button", { type: "button", class: "primary", disabled: !canAdvance(), onclick: () => go(app.index + 1) }, "Next")
    );

    // A build that started from a base says so, and says when it has been customized.
    const base = app.state.base ? (catalog.bases ?? []).find((b) => b.id === app.state.base) : null;
    const basedOn = base
      ? [el("p", { class: "meta" }, `Based on ${base.name}${isCustomized(app.state, base, catalog) ? " (customized)" : ""}.`)]
      : [];
    const notices = [...basedOn, ...app.notices.map((n) => el("p", { class: "notice", role: "note" }, n))];

    root.replaceChildren(
      el("section", { class: "wizard" }, notices, stepper, el("div", { class: "step" }, heading, content), app.message ? el("p", { role: "status" }, app.message) : null, nav)
    );
    if (moved) heading.focus();
  }

  render();
}
