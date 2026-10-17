import { defineConfig } from "vite";

// The site is static: relative base so it works under /<repo>/ on GitHub Pages.
// site/public (catalog.json, catalog/ screenshots, install.sh) is copied to dist/ as-is.
export default defineConfig({
  root: "site",
  publicDir: "public",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
