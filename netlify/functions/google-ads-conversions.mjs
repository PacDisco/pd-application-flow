// GET /api/ads/google-conversions.csv — offline conversions for Google Ads to
// fetch on a schedule (Basic auth). See _lib/google-offline.mjs.
import { db } from "./_lib/db.mjs";
import { safeEqual } from "./_lib/http.mjs";
import { parseNames, feedRows, toCsv } from "./_lib/google-offline.mjs";

export const config = { path: "/api/ads/google-conversions.csv" };

function authorised(req) {
  const user = process.env.GOOGLE_ADS_FEED_USER || "";
  const pass = process.env.GOOGLE_ADS_FEED_PASSWORD || "";
  if (!user || pass.length < 16) return false;
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = Buffer.from(h.slice(6), "base64").toString("utf8"); } catch { return false; }
  const i = decoded.indexOf(":");
  return i > 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

export default async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!authorised(req)) {
    return new Response("Unauthorised", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="pd-apply conversions"', "Cache-Control": "no-store" } });
  }
  const names = parseNames();
  if (!Object.keys(names).length) return new Response("GOOGLE_ADS_OFFLINE_NAMES is not set", { status: 503 });
  try {
    const apps = await db().query(
      `SELECT id, email, attribution, step2_at, paid_at, payment, enrolment, deal_amount
         FROM applications
        WHERE attribution IS NOT NULL AND created_at > now() - interval '200 days'
        ORDER BY created_at`);
    const body = toCsv(feedRows(apps, names), { withEmail: ["on", "1", "true", "yes"].includes(String(process.env.GOOGLE_ADS_FEED_EMAIL || "").toLowerCase()) });
    return new Response(req.method === "HEAD" ? null : body, {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  } catch (err) {
    console.error("[google-ads-conversions]", err);
    return new Response("Error building the feed", { status: 500 });
  }
};
