// Uploaded files (the applicant photo). Not public: callers need the
// x-apply-key service header — the portals' document proxies and the
// dashboard add it server-side; the browser never sees the key.
//   GET /api/file/<uuid>

import { db } from "./_lib/db.mjs";
import { serviceOk, json } from "./_lib/http.mjs";
import { uploadStore } from "./apply.mjs";

export const config = { path: "/api/file/:id" };

export default async (req, context) => {
  if (!serviceOk(req)) return json({ error: "Forbidden" }, 403);
  const id = context.params?.id || new URL(req.url).pathname.split("/").pop();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Not found" }, 404);
  const rows = await db()`SELECT filename, content_type, blob_key FROM apply_files WHERE id = ${id}`;
  if (!rows[0]) return json({ error: "Not found" }, 404);
  const data = await uploadStore().get(rows[0].blob_key, { type: "arrayBuffer" });
  if (!data) return json({ error: "Not found" }, 404);
  return new Response(data, {
    headers: {
      "Content-Type": rows[0].content_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${rows[0].filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
};
