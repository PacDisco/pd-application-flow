// Public API for the application flow.
//
//   GET  /api/apply/schema                    published form (fields, programs, terms, fee)
//   POST /api/apply/start      { values, hp }  step 1 → { token, status }
//   GET  /api/apply/status?token=&session_id=  where this applicant is up to
//   POST /api/apply/step2      { token, values }
//   POST /api/apply/upload     multipart: token, field, file → { id, name, size, type }
//   POST /api/apply/interview  { token, booking }
//   POST /api/apply/checkout   { token } → { url }   (Stripe Checkout, $250 + 3.5%)
//
// The applicant's `token` is the only credential: it is returned once by
// /start, kept in the browser, and stored hashed.

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { db, publishedSchema } from "./_lib/db.mjs";
import { json, readJson, errorResponse, siteUrl, flag } from "./_lib/http.mjs";
import * as K from "../../public/form-kit.mjs";
import * as A from "./_lib/applications.mjs";
import { createAppFeeCheckout, getCheckoutSession } from "./_lib/stripe.mjs";

export const config = { path: "/api/apply/*" };

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/apply\/?/, "").replace(/\/+$/, "");
  try {
    if (req.method === "GET" && route === "schema") return await getSchema();
    if (req.method === "GET" && route === "status") return await status(url);
    if (req.method === "POST" && route === "start") return await start(req, context);
    if (req.method === "POST" && route === "step2") return await step2(req);
    if (req.method === "POST" && route === "upload") return await upload(req);
    if (req.method === "POST" && route === "interview") return await interview(req);
    if (req.method === "POST" && route === "checkout") return await checkout(req);
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return errorResponse(err, `apply:${route}`);
  }
};

// ── schema ─────────────────────────────────────────────────────────────────

/** What the browser needs. Integration details (HubSpot mapping) are stripped. */
export function publicSchema(schema) {
  const steps = (schema.steps || []).map((st) => ({
    ...st,
    sections: (st.sections || []).map((sec) => ({
      ...sec,
      fields: (sec.fields || []).map(({ hubspot, jf, ...f }) => f),
    })),
  }));
  const { jotform, ...settings } = schema.settings || {};
  return {
    settings,
    programs: (schema.programs || []).filter((p) => p.active !== false).map(({ name, type, price }) => ({ name, type, price, active: true })),
    terms: (schema.terms || []).filter((t) => t.active !== false),
    lists: schema.lists || {},
    steps,
    fee: K.feeBreakdown(schema),
  };
}

async function getSchema() {
  const { schema, rev } = await publishedSchema();
  return json({ rev, schema: publicSchema(schema) }, 200, { "Cache-Control": "public, max-age=30" });
}

// ── status ─────────────────────────────────────────────────────────────────

/** Has the interview step been dealt with (booked, skipped, or handed to admissions)? */
export function interviewCleared(app, schema) {
  if (app.interview_at) return true;
  const st = schema?.settings || {};
  if (app.interview?.skipped && st.allowSkipInterview) return true;
  if (app.interview?.fallback && fallbackOn(schema)) return true;
  return false;
}

/** The "Having trouble booking?" fallback is on unless switched off in the dashboard. */
export function fallbackOn(schema) {
  return schema?.settings?.interviewFallback !== false;
}

function nextStep(app, schema) {
  if (app.paid_at) return "done";
  if (!app.step2_at) return "step2";
  if (!interviewCleared(app, schema)) return "interview";
  return "payment";
}

function statusBody(app, schema) {
  return {
    step: nextStep(app, schema),
    firstName: app.first_name,
    lastName: app.last_name,
    email: app.email,
    mobile: app.answers?.mobile || null, // so step 2 can check parents' numbers differ
    program: app.program,
    term: app.term,
    interview: app.interview_at ? { at: app.interview_at, label: app.interview?.label || null } : null,
    interviewNeeded: !app.interview_at && !!app.interview?.fallback, // admissions will arrange it
    paid: !!app.paid_at,
    paidAt: app.paid_at,
    fee: K.feeBreakdown(schema),
    // step-2 answers are NOT returned (health / passport data never goes back
    // to the browser); the client keeps its own unsent draft.
  };
}

async function status(url) {
  const app = await A.byToken(url.searchParams.get("token"));
  if (!app) throw bad("We couldn't find that application. Please start again.", 404);
  const { schema } = await publishedSchema();
  let current = app;
  const sessionId = url.searchParams.get("session_id");
  // Returning from Stripe: confirm the payment directly instead of waiting for
  // the webhook, so the applicant sees "paid" immediately.
  if (sessionId && !app.paid_at) {
    try {
      const session = await getCheckoutSession(sessionId);
      if (session?.payment_status === "paid" && session.client_reference_id === app.id) {
        const r = await recordPayment(app.id, session);
        current = r.app;
        if (r.first) await A.triggerSync(app.id, { schema });
      }
    } catch (err) { console.warn("[status] session check failed:", err.message); }
  }
  return json(statusBody(current, schema));
}

/** Shared by the return-page check and the Stripe webhook. */
export async function recordPayment(appId, session) {
  const meta = session.metadata || {};
  const total = (session.amount_total ?? 0) / 100;
  const base = Number(meta.base_amount || 250);
  return A.markPaid(appId, {
    provider: "stripe",
    sessionId: session.id,
    reference: session.payment_intent || session.id,
    base,
    surcharge: Math.round((total - base) * 100) / 100,
    total,
    currency: session.currency,
    paidAt: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
  });
}

// ── step 1 ─────────────────────────────────────────────────────────────────

const ATTR_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "referrer", "landing"];

async function start(req, context) {
  const body = await readJson(req);
  if (body.hp) return json({ error: "Please try again." }, 400); // honeypot
  const { schema, rev } = await publishedSchema();
  const values = body.values && typeof body.values === "object" ? body.values : {};
  const res = K.validateStep(schema, "step1", values);
  if (!res.ok) return json({ error: "Please check the highlighted fields.", errors: res.errors }, 422);
  if (!K.programByName(schema, res.clean.program)) return json({ error: "Please choose a program.", errors: { program: "Please choose a program." } }, 422);

  // Light abuse guard: at most 8 new applications per IP per hour.
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || null;
  if (ip) {
    const rows = await db()`SELECT count(*)::int AS n FROM applications WHERE ip = ${ip} AND created_at > now() - interval '1 hour'`;
    if ((rows[0]?.n || 0) >= 8) throw bad("Too many applications from this connection. Please try again later.", 429);
  }

  const attribution = {};
  for (const k of ATTR_KEYS) if (body.attribution?.[k]) attribution[k] = String(body.attribution[k]).slice(0, 500);
  const { app, token } = await A.createFromStep1({ schema, rev, clean: res.clean, attribution, ip, userAgent: req.headers.get("user-agent") });
  await A.triggerSync(app.id, { schema });
  return json({ token, status: statusBody(app, schema) });
}

// ── step 2 ─────────────────────────────────────────────────────────────────

async function step2(req) {
  const body = await readJson(req, 512 * 1024);
  const app = await A.byToken(body.token);
  if (!app) throw bad("We couldn't find that application. Please start again.", 404);
  if (app.step2_at) {
    const { schema } = await publishedSchema();
    return json({ status: statusBody(app, schema), already: true });
  }
  const { schema, rev } = await publishedSchema();
  const values = body.values && typeof body.values === "object" ? body.values : {};
  // Conditions may reference step-1 answers (program, term …).
  const merged = { ...app.answers, ...values };
  const res = K.validateStep(schema, "step2", merged);
  if (!res.ok) return json({ error: "Please check the highlighted fields.", errors: res.errors }, 422);

  // Uploaded files must belong to this application.
  for (const f of K.stepFields(schema, "step2").filter((x) => x.type === "file")) {
    const list = res.clean[f.key] || [];
    if (!list.length) continue;
    const ids = list.map((x) => x.id);
    const rows = await db()`SELECT id, filename, content_type, size FROM apply_files WHERE application_id = ${app.id} AND id = ANY(${ids})`;
    if (rows.length !== ids.length) return json({ error: "Please upload your file again.", errors: { [f.key]: "Please upload your file again." } }, 422);
    res.clean[f.key] = rows.map((r) => ({ id: r.id, name: r.filename, type: r.content_type, size: r.size }));
  }

  const updated = await A.saveStep2(app, { schema, rev, clean: res.clean });
  await A.triggerSync(app.id, { schema });
  return json({ status: statusBody(updated, schema) });
}

// ── uploads ────────────────────────────────────────────────────────────────

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif"]);

function uploadStore() {
  if (globalThis.__applyTestStore) return globalThis.__applyTestStore;
  try { return getStore({ name: "apply-uploads" }); } catch {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: "apply-uploads", siteID, token });
    throw new Error("Netlify Blobs is not available");
  }
}
export { uploadStore };

async function upload(req) {
  const form = await req.formData().catch(() => null);
  if (!form) throw bad("Upload failed — please try again.");
  const app = await A.byToken(String(form.get("token") || ""));
  if (!app) throw bad("We couldn't find that application. Please start again.", 404);
  const { schema } = await publishedSchema();
  const field = K.fieldByKey(schema, String(form.get("field") || ""));
  if (!field || field.type !== "file") throw bad("That upload isn't expected.");
  const file = form.get("file");
  if (!file || typeof file === "string") throw bad("Please choose a file.");
  const max = Number(field.maxMb || 10) * 1024 * 1024;
  if (file.size > max) throw bad(`That file is larger than ${field.maxMb || 10} MB.`, 413);
  const type = String(file.type || "").toLowerCase();
  if (String(field.accept || "").startsWith("image/") && !IMAGE_TYPES.has(type)) throw bad("Please upload a photo (JPG, PNG, GIF, WebP or HEIC).");
  const count = await db()`SELECT count(*)::int AS n FROM apply_files WHERE application_id = ${app.id}`;
  if ((count[0]?.n || 0) >= 20) throw bad("Too many uploads for this application.", 429);

  const id = crypto.randomUUID();
  const name = String(file.name || "upload").replace(/[^\w.\- ]+/g, "_").slice(-120);
  const key = `${app.id}/${id}`;
  await uploadStore().set(key, await file.arrayBuffer(), { metadata: { type, name, applicationId: app.id } });
  await db()`INSERT INTO apply_files (id, application_id, field_key, filename, content_type, size, blob_key)
             VALUES (${id}, ${app.id}, ${field.key}, ${name}, ${type}, ${file.size}, ${key})`;
  return json({ id, name, size: file.size, type });
}

// ── interview ──────────────────────────────────────────────────────────────

async function interview(req) {
  const body = await readJson(req);
  const app = await A.byToken(body.token);
  if (!app) throw bad("We couldn't find that application.", 404);
  if (!app.step2_at) throw bad("Please finish your application first.", 409);
  const { schema } = await publishedSchema();
  const b = body.booking && typeof body.booking === "object" ? body.booking : {};
  if (b.skipped && !schema.settings?.allowSkipInterview) throw bad("Please book your interview to continue.", 409);
  if (b.fallback) {
    // "Can't find a time / the calendar won't load" — continue to payment and
    // tell admissions to arrange the interview by hand.
    if (!fallbackOn(schema)) throw bad("Please book your interview to continue.", 409);
    if (app.interview_at) return json({ status: statusBody(app, schema) });
    const REASONS = { no_times: "No suitable times", wont_load: "The calendar wouldn't load", other: "Other" };
    const fb = {
      source: "fallback", fallback: true,
      reason: REASONS[b.reason] ? b.reason : "other",
      reasonLabel: REASONS[b.reason] || REASONS.other,
      note: typeof b.note === "string" ? b.note.trim().slice(0, 1000) : "",
      at: new Date().toISOString(),
    };
    const rows = await db()`UPDATE applications SET interview = ${JSON.stringify(fb)}, updated_at = now() WHERE id = ${app.id} RETURNING *`;
    await A.triggerSync(app.id, { schema });
    return json({ status: statusBody(rows[0] || { ...app, interview: fb }, schema) });
  }
  const booking = {
    source: b.skipped ? "skipped" : "hubspot-meetings",
    skipped: !!b.skipped,
    start: typeof b.start === "string" ? b.start.slice(0, 40) : null,
    label: typeof b.label === "string" ? b.label.slice(0, 200) : null,
    organizer: typeof b.organizer === "string" ? b.organizer.slice(0, 120) : null,
  };
  if (booking.skipped) {
    await db()`UPDATE applications SET interview = ${JSON.stringify(booking)}, updated_at = now() WHERE id = ${app.id}`;
    return json({ status: statusBody({ ...app, interview: booking }, schema) });
  }
  const updated = await A.markInterview(app, booking);
  await A.triggerSync(app.id, { schema });
  return json({ status: statusBody(updated, schema) });
}

// ── payment ────────────────────────────────────────────────────────────────

async function checkout(req) {
  const body = await readJson(req);
  const app = await A.byToken(body.token);
  if (!app) throw bad("We couldn't find that application.", 404);
  if (app.paid_at) throw bad("Your application fee has already been paid.", 409);
  if (!app.step2_at) throw bad("Please finish your application first.", 409);
  const { schema } = await publishedSchema();
  if (!interviewCleared(app, schema)) {
    throw bad("Please book your interview first.", 409);
  }
  const fee = K.feeBreakdown(schema);
  const base = siteUrl();
  const ret = `${base}/?token=${encodeURIComponent(body.token)}`;
  const session = await createAppFeeCheckout({
    app, fee, currency: String(schema.settings?.currency || "usd").toLowerCase(),
    successUrl: `${ret}&paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ret}&cancelled=1`,
    dealId: app.hubspot_deal_id,
  });
  return json({ url: session.url });
}

export const _test = { statusBody, nextStep, flag };
