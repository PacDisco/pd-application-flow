// GET /tracking-config.js — the ad/analytics tag IDs from the environment, as a
// tiny script that sets window.PD_TRACKING before /tracking.js runs. Same-origin,
// so the CSP needs no inline script. See _lib/tracking.mjs for the variables.
import { browserConfig } from "./_lib/tracking.mjs";

export const config = { path: "/tracking-config.js" };

export default async () => new Response(`window.PD_TRACKING=${JSON.stringify(browserConfig())};\n`, {
  status: 200,
  headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
});
