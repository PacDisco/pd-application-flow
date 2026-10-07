// Background sync (Netlify background function — up to 15 minutes; the
// "-background" filename suffix is what makes it one).
// Called by the flow after every step, and by the dashboard's "Retry sync".
// Body: { id }. Requires the x-apply-key service header.
//
// Written in the classic handler format, which background functions support
// on every Netlify plan that has them. If the site's plan has no background
// functions the call fails and the flow runs the sync inline instead
// (see triggerSync in _lib/applications.mjs).

import { safeEqual } from "./_lib/http.mjs";
import { publishedSchema } from "./_lib/db.mjs";
import { syncApplication } from "./_lib/applications.mjs";

export const handler = async (event) => {
  const key = process.env.APPLY_SERVICE_KEY;
  const given = event.headers?.["x-apply-key"] || event.headers?.["X-Apply-Key"];
  if (!key || !safeEqual(given, key)) return { statusCode: 403, body: "Forbidden" };
  let id;
  try { ({ id } = JSON.parse(event.body || "{}")); } catch { return { statusCode: 400, body: "Bad request" }; }
  const { schema } = await publishedSchema({ fresh: true });
  const result = await syncApplication(id, { schema });
  console.log("[apply-sync]", id, JSON.stringify(result));
  return { statusCode: 200, body: "ok" };
};
