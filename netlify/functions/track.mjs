// POST /api/track/form — a HubSpot form on pacificdiscovery.org was submitted
// (reported by /hs-form-tracking.js, loaded on the main site via GTM).
// Sends the matching Meta Conversions API event; the browser pixel fires the
// same event with the same event ID, so Meta counts it once.
//
// Body (JSON, sent as text/plain via sendBeacon to avoid a CORS preflight):
//   { formId, eventId, fields: { email, firstname, lastname, phone }, page, ads: { fbp, fbc }, attr }
import { siteFormEvent, sendMeta } from "./_lib/tracking.mjs";

export const config = { path: "/api/track/*" };

const ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*pacificdiscovery\.org$/i;
const hits = new Map(); // light per-instance rate limit: 10 reports / IP / 10 min

function cors(req) {
  const o = req.headers.get("origin") || "";
  return ORIGIN_RE.test(o) ? { "Access-Control-Allow-Origin": o, Vary: "Origin" } : {};
}

export default async (req, context) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/track\/?/, "").replace(/\/+$/, "");
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...h, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
  if (req.method !== "POST" || route !== "form") return new Response("Not found", { status: 404, headers: h });

  // Only accept reports from the Pacific Discovery sites.
  const origin = req.headers.get("origin") || "";
  const referer = req.headers.get("referer") || "";
  let refOrigin = ""; try { refOrigin = new URL(referer).origin; } catch { /* none */ }
  if (!ORIGIN_RE.test(origin) && !ORIGIN_RE.test(refOrigin)) return new Response("Forbidden", { status: 403, headers: h });

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 600000);
  if (list.length >= 10) return new Response("Too many", { status: 429, headers: h });
  list.push(now); hits.set(ip, list);

  let body;
  try { const text = await req.text(); body = text.length <= 16384 ? JSON.parse(text) : null; } catch { body = null; }
  const out = siteFormEvent(body, { ip, userAgent: req.headers.get("user-agent") });
  if (out.error) return new Response(JSON.stringify({ error: out.error }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });
  const r = await sendMeta(out.event);
  return new Response(JSON.stringify({ ok: !!r.ok, skipped: r.skipped }), { status: 200, headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
};
