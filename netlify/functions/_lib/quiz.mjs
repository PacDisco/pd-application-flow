// Quiz responses: store, then send to HubSpot (form submission with the
// visitor cookie → real Original Source; then source + quiz properties).
import { db } from "./db.mjs";
import * as K from "../../../public/form-kit.mjs";
import * as Q from "../../../public/quiz-kit.mjs";
import * as HSF from "./hsforms.mjs";
import SEED from "./quiz-seed.mjs";

let _cache = null;
const TTL = 30 * 1000;

/** The published quiz, or the bundled one until a quiz is published from the dashboard. */
export async function publishedQuiz({ fresh = false } = {}) {
  if (!fresh && _cache && Date.now() - _cache.at < TTL) return _cache;
  let row = null;
  try { row = (await db()`SELECT published, published_rev FROM apply_forms WHERE id = ${Q.QUIZ_FORM_ID}`)[0]; }
  catch (err) { console.warn("[quiz] schema read failed, using bundled quiz:", err.message); }
  _cache = row?.published ? { at: Date.now(), schema: row.published, rev: row.published_rev } : { at: Date.now(), schema: SEED, rev: 0 };
  return _cache;
}
export function __resetQuizCache() { _cache = null; }

export async function createResponse({ schema, rev, clean, scored, attribution, ip, userAgent }) {
  const name = clean.name || {};
  const rows = await db().query(
    `INSERT INTO quiz_responses (email, first_name, last_name, phone, answers, scores, archetype, form_rev, attribution, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [String(clean.email).toLowerCase(), name.first || null, name.last || null, clean.mobile ? K.phoneText(clean.mobile) : null,
      JSON.stringify(clean), JSON.stringify(scored.scores), scored.archetype, rev ?? null, JSON.stringify(attribution || {}), ip || null, String(userAgent || "").slice(0, 300)]);
  return rows[0];
}

export async function byId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  return (await db().query(`SELECT * FROM quiz_responses WHERE id = $1`, [id]))[0] || null;
}

async function setSync(id, patch, contactId) {
  await db().query(`UPDATE quiz_responses SET sync = sync || $2::jsonb, hubspot_contact_id = COALESCE($3, hubspot_contact_id) WHERE id = $1`, [id, JSON.stringify(patch), contactId || null]);
}

const hsReady = () => !!(process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_PRIVATE_APP_TOKEN);

export async function syncQuiz(id, { schema, inline = false, force = false } = {}) {
  const r = await byId(id);
  if (!r) return { error: "not found" };
  if (!hsReady()) return { skipped: "HUBSPOT_TOKEN not set" };
  if (r.sync?.hubspot?.ok && !force) return { skipped: "done" };
  const sc = schema || (await publishedQuiz()).schema;
  const answers = r.answers || {};
  const phone = answers.mobile ? K.phoneText(answers.mobile) : r.phone || "";
  try {
    const out = await HSF.submitAndAttribute({
      formGuid: String(sc.settings?.hubspotFormGuid || process.env.HUBSPOT_QUIZ_FORM_GUID || "").trim(),
      fields: { email: r.email, firstname: r.first_name || "", lastname: r.last_name || "", phone },
      attr: r.attribution || {}, ip: r.ip, conversion: "Gap year quiz", waitMs: inline ? 6000 : 30000,
      alreadySubmitted: !!r.sync?.form?.ok,
      extraProps: { ...Q.quizContactProps(sc, answers, r.archetype, { date: new Date(r.created_at).toISOString().slice(0, 10) }), company_tag: process.env.HUBSPOT_COMPANY_TAG || "Pacific Discovery" },
    });
    await setSync(r.id, {
      form: { ok: out.formOk, error: out.formError || undefined, at: new Date().toISOString() },
      hubspot: { ok: true, at: new Date().toISOString(), dropped: out.dropped, note: out.note, waited: out.waited },
    }, out.contactId);
    return { ok: true, contactId: out.contactId, form: out.formOk, formError: out.formError };
  } catch (err) {
    console.error("[quiz sync]", err.message);
    await setSync(r.id, { hubspot: { ok: false, error: err.message.slice(0, 500), at: new Date().toISOString() } });
    return { error: err.message };
  }
}

export async function triggerQuizSync(id, { schema } = {}) {
  const base = (process.env.URL || process.env.APPLY_SITE_URL || "").replace(/\/+$/, "");
  if (base && process.env.APPLY_SERVICE_KEY) {
    try {
      const res = await fetch(`${base}/.netlify/functions/quiz-sync-background`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-apply-key": process.env.APPLY_SERVICE_KEY }, body: JSON.stringify({ id }),
      });
      if (res.status === 202 || res.ok) return { mode: "background" };
    } catch (err) { console.warn("[triggerQuizSync] background call failed:", err.message); }
  }
  return { mode: "inline", result: await syncQuiz(id, { schema, inline: true }) };
}
