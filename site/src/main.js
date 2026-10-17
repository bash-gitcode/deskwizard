import "./style.css";
import { startWizard } from "./wizard.js";

const app = document.getElementById("app");

// catalog.json is compiled from catalog/ by scripts/build-catalog.mjs and copied to the site root.
fetch("catalog.json")
  .then((res) => {
    if (!res.ok) throw new Error(`catalog.json returned ${res.status}`);
    return res.json();
  })
  .then((catalog) => startWizard(app, catalog))
  .catch((err) => {
    app.textContent = `Could not load the catalog: ${err.message}. Run "npm run build" first.`;
  });
