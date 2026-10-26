// Public Program Terms & Conditions.
//
//   GET /api/terms           → { title, version, publishedAt, markdown, html }  (live version)
//   GET /api/terms?v=3       → that version (what a family agreed to)
//
// Open to any origin: www.pacificdiscovery.org renders it with /terms-embed.js.
import { json, errorResponse } from "./_lib/http.mjs";
import { publishedTerms } from "./_lib/terms.mjs";
import { termsToHtml } from "../../public/terms-kit.mjs";

export const config = { path: "/api/terms" };

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, CORS);
  try {
    const v = new URL(req.url).searchParams.get("v");
    if (v != null && !/^\d{1,6}$/.test(v)) return json({ error: "Bad version" }, 400, CORS);
    const t = await publishedTerms({ version: v == null ? null : Number(v) });
    if (!t) return json({ error: v ? "No such version" : "The terms have not been published yet." }, 404, CORS);
    return json(
      { title: t.title, version: t.version, publishedAt: t.publishedAt, markdown: t.body, html: termsToHtml(t.body) },
      200,
      { ...CORS, "Cache-Control": v ? "public, max-age=86400" : "public, max-age=60" },
    );
  } catch (err) {
    const res = errorResponse(err, "terms");
    for (const [k, val] of Object.entries(CORS)) res.headers.set(k, val);
    return res;
  }
};
