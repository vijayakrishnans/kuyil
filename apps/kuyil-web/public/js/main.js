import { K, api, loadMe, render } from "./core.js";
import "./timeline.js";
import "./feeds.js";
import "./wallet.js";

(async () => {
  try { K.env = (await api("GET", "/v1/social/health")).data.environment; } catch { K.env = null; }
  try { await loadMe(); } catch { /* the page still renders signed out */ }
  await render();
})();
