// Service API for the portals and the dashboard (x-apply-key required).
// Returns applications in Jotform submission shape so existing readers can
// merge them with their Jotform results without any other change.
//
//   GET  /api/service/submissions?form=<jotformFormId|step1|step2>&email=&limit=&offset=
//   GET  /api/service/submission/<pda_id>?form=step2
//   POST /api/service/submission/<pda_id>     form-encoded submission[qid]=… (portal edits)
//   POST /api/service/resync   { id }         re-run Jotform/HubSpot sync (dashboard)

import { db, publishedSchema } from "./_lib/db.mjs";
import { serviceOk, json, errorResponse, fileUrl } from "./_lib/http.mjs";
import * as K from "../../public/form-kit.mjs";
import * as A from "./_lib/applications.mjs";
import * as JF from "./_lib/jotform.mjs";

export const config = { path: ["/api/service/*"] };

export const PREFIX = "pda_";

function jfDate(d) {
  if (!d) return null;
  return new Date(d).toISOString().replace("T", " ").slice(0, 19);
}

function formKey(schema, form) {
  const f = String(form || "step2");
  if (f === "step1" || f === "step2") return f;
  const jf = schema?.settings?.jotform || {};
  if (String(jf.step1) === f) return "step1";
  if (String(jf.step2) === f) return "step2";
  return null;
}

export function toSubmission(app, step, schema) {
  const shape = step === "step1" ? app.jf_step1 : app.jf_step2;
  return {
    id: `${PREFIX}${app.id}`,
    form_id: String(schema?.settings?.jotform?.[step] || step),
    created_at: jfDate(step === "step1" ? app.step1_at : app.step2_at || app.created_at),
    updated_at: jfDate(app.updated_at),
    status: "ACTIVE",
    new: "0",
    source: "pd-apply",
    jotform_id: (step === "step1" ? app.jotform_step1_id : app.jotform_step2_id) || null,
    application_status: app.status,
    answers: shape?.answers || {},
  };
}

export default async (req) => {
  if (!serviceOk(req)) return json({ error: "Forbidden" }, 403);
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/service\/?/, "");
  try {
    const { schema } = await publishedSchema();
    if (req.method === "GET" && route === "submissions") return await list(url, schema);
    const m = /^submission\/(pda_[0-9a-f-]{36})$/i.exec(route);
    if (m && req.method === "GET") return await getOne(m[1], url, schema);
    if (m && req.method === "POST") return await update(m[1], req, schema);
    if (req.method === "POST" && route === "resync") {
      const { id } = await req.json();
      const app = await A.byId(id);
      if (!app) return json({ error: "Not found" }, 404);
      // A manual retry clears recorded errors so failed targets run again.
      await db()`UPDATE applications SET sync_lock = NULL,
        sync = sync - 'hsError' - 'hsPaidError' - 'hsInterviewError' WHERE id = ${id}`;
      const result = await A.syncApplication(id, { schema });
      return json({ ok: true, result, app: await A.byId(id) });
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return errorResponse(err, `service:${route}`);
  }
};

async function list(url, schema) {
  const step = formKey(schema, url.searchParams.get("form"));
  if (!step) return json({ content: [], note: "form is not a pd-apply form" });
  const email = String(url.searchParams.get("email") || "").toLowerCase().trim();
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "1000", 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const col = step === "step1" ? "step1_at" : "step2_at";
  const rows = email
    ? await db().query(`SELECT * FROM applications WHERE lower(email) = $1 AND ${col} IS NOT NULL AND status <> 'withdrawn' ORDER BY ${col} DESC LIMIT $2 OFFSET $3`, [email, limit, offset])
    : await db().query(`SELECT * FROM applications WHERE ${col} IS NOT NULL AND status <> 'withdrawn' ORDER BY ${col} DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  return json({ responseCode: 200, content: rows.map((r) => toSubmission(r, step, schema)) });
}

async function getOne(pid, url, schema) {
  const app = await A.byId(pid.slice(PREFIX.length));
  if (!app) return json({ error: "Not found" }, 404);
  const step = formKey(schema, url.searchParams.get("form")) || "step2";
  return json({ responseCode: 200, content: toSubmission(app, step, schema) });
}

/**
 * Apply a portal edit (same submission[qid][sub] params the portals already
 * send to Jotform) to the stored answers, then mirror it to Jotform.
 */
export function applyParams(schema, answers, params) {
  const byQid = new Map();
  for (const { field } of K.allFields(schema)) if (field.qid && K.isInput(field)) byQid.set(String(field.qid), field);
  const next = { ...answers };
  const touched = [];
  for (const [k, v] of Object.entries(params)) {
    const m = /^submission\[(\d+)\](?:\[(\w+)\])?$/.exec(k);
    if (!m) continue;
    const field = byQid.get(m[1]);
    if (!field || field.type === "file" || field.type === "hidden") continue;
    const sub = m[2];
    const val = String(v ?? "");
    switch (field.type) {
      case "address": if (sub) next[field.key] = { ...(next[field.key] || {}), [sub]: val }; break;
      case "fullname": if (sub) next[field.key] = { ...(next[field.key] || {}), [sub]: val }; break;
      case "date":
        if (sub) {
          const cur = K.splitDate(next[field.key]) || { year: "", month: "", day: "" };
          cur[sub] = val.padStart(sub === "year" ? 4 : 2, "0");
          next[field.key] = `${cur.year}-${cur.month}-${cur.day}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(val)) next[field.key] = val;
        break;
      case "phone": {
        const cur = next[field.key] || {};
        if (sub === "country") { next[field.key] = { ...cur, cc: val.replace(/\D/g, "") }; break; }
        if (sub === "area") break;
        const intl = /^\+(\d{1,4})\s+(.+)$/.exec(val.trim());
        next[field.key] = intl ? { cc: intl[1], number: intl[2] } : { cc: cur.cc || "", number: val.trim() };
        break;
      }
      default: next[field.key] = val;
    }
    touched.push(field.key);
  }
  return { answers: K.computeDerived(schema, next), touched };
}

async function update(pid, req, schema) {
  const app = await A.byId(pid.slice(PREFIX.length));
  if (!app) return json({ error: "Not found" }, 404);
  const params = Object.fromEntries(new URLSearchParams(await req.text()));
  const { answers, touched } = applyParams(schema, app.answers || {}, params);
  const { jf1, jf2 } = A.jotformShapes(schema, answers);
  await db()`UPDATE applications SET answers = ${JSON.stringify(answers)}, jf_step1 = ${JSON.stringify(jf1)},
    jf_step2 = ${JSON.stringify(jf2)}, updated_at = now() WHERE id = ${app.id}`;
  let mirrored = false;
  if (A.mirrorOn() && app.jotform_step2_id) {
    try { await JF.updateSubmission(app.jotform_step2_id, params); mirrored = true; }
    catch (err) { console.warn("[service:update] Jotform mirror failed:", err.message); }
  }
  return json({ responseCode: 200, content: { submissionID: pid, touched, mirrored } });
}

export { fileUrl };
