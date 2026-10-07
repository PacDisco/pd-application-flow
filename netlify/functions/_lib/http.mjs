import crypto from "node:crypto";

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export async function readJson(req, max = 256 * 1024) {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error("Request is too large."), { status: 413 });
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
}

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Service-to-service calls (portals, dashboard, background sync). */
export function serviceOk(req) {
  const key = process.env.APPLY_SERVICE_KEY;
  return !!key && safeEqual(req.headers.get("x-apply-key"), key);
}

export function siteUrl() {
  return (process.env.APPLY_SITE_URL || process.env.URL || "").replace(/\/+$/, "");
}

/** Permanent URL of an uploaded file. Fetching it needs the service key. */
export function fileUrl(file) {
  return file?.id ? `${siteUrl()}/api/file/${file.id}` : "";
}

export function errorResponse(err, label) {
  const status = err?.status || 500;
  if (status >= 500) console.error(`[${label}]`, err);
  return json({ error: status >= 500 ? "Something went wrong on our side. Please try again in a moment." : err.message }, status);
}

export function flag(name, dflt) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return dflt;
  return ["1", "on", "true", "yes"].includes(v);
}
