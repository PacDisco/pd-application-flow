// Application records + the sync that pushes them to Jotform and HubSpot.
//
// One row per application in `applications` (see MIGRATION-apply.sql in
// pd-dashboard). The row keeps:
//   answers    every answer, keyed by field key (step 1 + step 2 + derived)
//   jf_step1   the step-1 record in Jotform submission shape   ┐ what the
//   jf_step2   the full application in Jotform submission shape ┘ portals read
//   sync       per-target status { jf1, jf2, hsContact, hsDeal, hsStep2, hsInterview, hsPaid }
//
// Sync is idempotent and safe to re-run: every target records when it
// succeeded and is skipped afterwards. A short row lock stops two runs (the
// step-1 sync still going when step 2 lands) from creating duplicate deals.

import { db } from "./db.mjs";
import { hashToken, newToken, fileUrl, flag } from "./http.mjs";
import * as K from "../../../public/form-kit.mjs";
import * as HS from "./hubspot.mjs";
import * as JF from "./jotform.mjs";
import * as R from "./routing.mjs";
import { alertOn, sendStep1Alert } from "./notify.mjs";

export const mirrorOn = () => flag("JOTFORM_MIRROR", true);
export const hubspotSyncOn = () => flag("HUBSPOT_SYNC", true);
export const paymentSyncOn = () => flag("HUBSPOT_PAYMENT_SYNC", true);

const COLS = `id, email, first_name, last_name, program, term, season, travel_year, program_type, deal_amount, status,
  answers, form_rev, jf_step1, jf_step2, step1_at, step2_at, interview_at, interview, paid_at, payment,
  hubspot_contact_id, hubspot_deal_id, jotform_step1_id, jotform_step2_id, sync, created_at, updated_at`;

export async function byToken(token) {
  if (!token || typeof token !== "string" || token.length < 20) return null;
  const rows = await db().query(`SELECT ${COLS} FROM applications WHERE token_hash = $1`, [hashToken(token)]);
  return rows[0] || null;
}

export async function byId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const rows = await db().query(`SELECT ${COLS} FROM applications WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Jotform-shaped records for both forms from the merged answers. */
export function jotformShapes(schema, answers) {
  const opts = { fileUrl };
  return {
    jf1: { answers: K.toJotformAnswers(schema, "step1", answers, opts) },
    jf2: { answers: K.toJotformAnswers(schema, "step2", answers, opts) },
  };
}

export async function createFromStep1({ schema, rev, clean, attribution, ip, userAgent }) {
  const token = newToken();
  const answers = K.computeDerived(schema, clean);
  const facts = K.enrolmentFacts(schema, answers);
  const { jf1 } = jotformShapes(schema, answers);
  const rows = await db().query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, season, travel_year, program_type,
       deal_amount, status, answers, form_rev, jf_step1, step1_at, attribution, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'step1',$11,$12,$13, now(), $14, $15, $16)
     RETURNING ${COLS}`,
    [hashToken(token), answers.email, answers.name?.first || "", answers.name?.last || "", facts.program, answers.term || "",
      facts.season, facts.year, facts.programType, facts.price, JSON.stringify(answers), rev, JSON.stringify(jf1),
      JSON.stringify(attribution || {}), ip || null, String(userAgent || "").slice(0, 300)],
  );
  return { app: rows[0], token };
}

export async function saveStep2(app, { schema, rev, clean }) {
  // Step-1 answers win for identity fields — step 2 never re-asks them.
  const answers = K.computeDerived(schema, { ...clean, ...pickStep(schema, "step1", app.answers) });
  const { jf1, jf2 } = jotformShapes(schema, answers);
  const rows = await db().query(
    `UPDATE applications SET answers = $2, form_rev = $3, jf_step1 = $4, jf_step2 = $5,
       step2_at = COALESCE(step2_at, now()),
       status = CASE WHEN status = 'step1' THEN 'step2' ELSE status END, updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [app.id, JSON.stringify(answers), rev, JSON.stringify(jf1), JSON.stringify(jf2)],
  );
  return rows[0];
}

function pickStep(schema, stepKey, answers) {
  const out = {};
  for (const f of K.stepFields(schema, stepKey)) if (answers?.[f.key] !== undefined) out[f.key] = answers[f.key];
  return out;
}

export async function markInterview(app, booking) {
  const rows = await db().query(
    `UPDATE applications SET interview = $2, interview_at = COALESCE(interview_at, now()),
       status = CASE WHEN status IN ('step1','step2') THEN 'interview' ELSE status END, updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [app.id, JSON.stringify(booking || {})],
  );
  return rows[0];
}

/** Idempotent: returns { app, first } — first=false when it was already paid. */
export async function markPaid(appId, payment) {
  const rows = await db().query(
    `UPDATE applications SET paid_at = now(), payment = $2, status = 'paid', updated_at = now()
     WHERE id = $1 AND paid_at IS NULL RETURNING ${COLS}`,
    [appId, JSON.stringify(payment)],
  );
  if (rows[0]) return { app: rows[0], first: true };
  return { app: await byId(appId), first: false };
}

async function setSync(id, patch, cols = {}) {
  const sets = ["sync = sync || $2::jsonb", "updated_at = now()"];
  const vals = [id, JSON.stringify(patch)];
  for (const [k, v] of Object.entries(cols)) {
    if (!["hubspot_contact_id", "hubspot_deal_id", "jotform_step1_id", "jotform_step2_id"].includes(k)) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  await db().query(`UPDATE applications SET ${sets.join(", ")} WHERE id = $1`, vals);
}

async function lock(id) {
  const rows = await db().query(
    `UPDATE applications SET sync_lock = now() + interval '3 minutes', sync_pending = false
     WHERE id = $1 AND (sync_lock IS NULL OR sync_lock < now()) RETURNING id`, [id]);
  if (rows[0]) return true;
  await db().query(`UPDATE applications SET sync_pending = true WHERE id = $1`, [id]);
  return false;
}

async function unlock(id) {
  const rows = await db().query(`UPDATE applications SET sync_lock = NULL WHERE id = $1 RETURNING sync_pending`, [id]);
  return !!rows[0]?.sync_pending;
}

const ok = (extra = {}) => ({ ok: true, at: new Date().toISOString(), ...extra });
const fail = (err) => ({ ok: false, at: new Date().toISOString(), error: String(err?.message || err).slice(0, 500) });

/** Contact / deal properties mapped in the form editor. */
export function hubspotProps(schema, answers, target) {
  const props = {};
  for (const { field } of K.allFields(schema)) {
    const map = field.hubspot?.[target];
    const v = answers[field.key];
    if (!map || v == null || v === "") continue;
    if (typeof map === "object" && field.type === "fullname") {
      if (map.first) props[map.first] = v.first || "";
      if (map.last) props[map.last] = v.last || "";
    } else if (typeof map === "string") {
      props[map] = field.type === "date" ? v : K.valueText(field, v);
    }
  }
  return props;
}

/** Run every outstanding sync target for one application. */
export async function syncApplication(id, { schema, log = console } = {}) {
  if (!(await lock(id))) return { skipped: "locked" };
  let again = false;
  const results = {};
  try {
    do {
      const app = await byId(id);
      if (!app) return { error: "not found" };
      Object.assign(results, await syncOnce(app, schema, log));
      again = await unlock(id);
      if (again && !(await lock(id))) break;
    } while (again);
  } catch (err) {
    await unlock(id).catch(() => {});
    throw err;
  }
  return results;
}

async function syncOnce(app, schema, log) {
  const s = app.sync || {};
  const out = {};
  const answers = app.answers || {};
  const jfForms = schema?.settings?.jotform || {};

  // ── Jotform mirror ───────────────────────────────────────────────────────
  if (mirrorOn() && app.step1_at && !app.jotform_step1_id && jfForms.step1) {
    try {
      const sid = await JF.createSubmission(jfForms.step1, K.toJotformParams(schema, "step1", answers, { fileUrl }));
      await setSync(app.id, { jf1: ok({ id: sid }) }, { jotform_step1_id: sid });
      app.jotform_step1_id = sid; out.jf1 = "ok";
    } catch (err) { log.error("[sync jf1]", err.message); await setSync(app.id, { jf1: fail(err) }); out.jf1 = err.message; }
  }
  if (mirrorOn() && app.step2_at && !app.jotform_step2_id && jfForms.step2) {
    try {
      const sid = await JF.createSubmission(jfForms.step2, K.toJotformParams(schema, "step2", answers, { fileUrl }));
      await setSync(app.id, { jf2: ok({ id: sid }) }, { jotform_step2_id: sid });
      app.jotform_step2_id = sid; out.jf2 = "ok";
    } catch (err) { log.error("[sync jf2]", err.message); await setSync(app.id, { jf2: fail(err) }); out.jf2 = err.message; }
  }

  const hsReady = !!(process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_PRIVATE_APP_TOKEN);

  // ── HubSpot: contact (always, from step 1) + applicant deal ──────────────
  // The contact is created/updated as soon as step 1 is in, in both modes —
  // upsert-by-email, so it never duplicates a contact the Zap also touches.
  // The deal is only created here when HUBSPOT_SYNC is on (otherwise the Zap
  // makes it, and step 2 / payment find it).
  if (hsReady) {
    try {
      if (!app.hubspot_contact_id || (app.step2_at && !s.hsStep2 && hubspotSyncOn())) {
        const props = { ...hubspotProps(schema, answers, "contact"), company_tag: process.env.HUBSPOT_COMPANY_TAG || "Pacific Discovery" };
        const c = await HS.upsertContact(app.email, props);
        app.hubspot_contact_id = c.id;
        await setSync(app.id, { hsContact: ok({ dropped: c.dropped, created: c.created }), hsError: undefined }, { hubspot_contact_id: c.id });
        out.hsContact = "ok";
      }
      if (hubspotSyncOn() && !app.hubspot_deal_id) {
        const deal = await createApplicantDeal(app, schema);
        app.hubspot_deal_id = deal.id;
        await setSync(app.id, { hsDeal: ok({ dropped: deal.dropped, reused: !!deal.reused }) }, { hubspot_deal_id: deal.id });
        out.hsDeal = "ok";
      }
    } catch (err) {
      log.error("[sync hubspot]", err.message);
      await setSync(app.id, { hsError: fail(err) });
      out.hubspot = err.message;
    }
  }

  // ── Alert admissions: new step-1 applicant ───────────────────────────────
  // Sent once, after the HubSpot contact attempt so the email can link to it.
  if (app.step1_at && !s.alert1 && alertOn()) {
    try {
      const to = await sendStep1Alert(app, schema);
      await setSync(app.id, { alert1: ok({ to }), alert1Error: undefined });
      out.alert1 = "ok";
    } catch (err) { log.error("[sync alert1]", err.message); await setSync(app.id, { alert1Error: fail(err) }); out.alert1 = err.message; }
  }

  if (!hsReady) return out;

  // ── HubSpot: full application in, fee not paid → PD Applications ─────────
  // Runs in both modes (HUBSPOT_SYNC on, or the Zap creating the deal): the
  // deal is put in the application pipeline at "Application Complete" so
  // admissions can see who applied but hasn't paid. Once the fee is paid the
  // payment step moves it on to the program pipeline instead.
  if (app.step2_at && !app.paid_at && !s.hsStep2 && (hubspotSyncOn() || paymentSyncOn())) {
    try {
      const r = await placeInApplicationPipeline(app, schema);
      await setSync(app.id, { hsStep2: ok(r), hsStep2Error: undefined }, { hubspot_deal_id: r.dealId, ...(r.contactId ? { hubspot_contact_id: r.contactId } : {}) });
      app.hubspot_deal_id = r.dealId;
      out.hsStep2 = "ok";
    } catch (err) { log.error("[sync step2]", err.message); await setSync(app.id, { hsStep2Error: fail(err) }); out.hsStep2 = err.message; }
  }

  // ── HubSpot: interview note (+ stage when the pipeline has one) ──────────
  if (app.interview_at && !s.hsInterview && (hubspotSyncOn() || paymentSyncOn())) {
    try {
      const { contactId, dealId } = await resolveHubspot(app, schema);
      const when = app.interview?.label || app.interview?.start || "a time chosen in the scheduler";
      await HS.addNote(`<p><strong>Admissions interview booked</strong> via the online application: ${escapeHtml(when)}.</p>`, { contactId, dealId });
      if (dealId) {
        const deal = await HS.getDeal(dealId);
        const pipes = await HS.dealPipelines();
        const pipe = pipes.find((p) => p.id === String(deal?.properties?.pipeline));
        const st = R.findStage(pipe, "interviewBooked");
        if (st && pipe && R.APPLICANT_PIPELINE.test(pipe.label)) await HS.updateDeal(dealId, { dealstage: st.id });
      }
      await setSync(app.id, { hsInterview: ok() });
      out.hsInterview = "ok";
    } catch (err) { log.error("[sync interview]", err.message); await setSync(app.id, { hsInterview: undefined, hsInterviewError: fail(err) }); out.hsInterview = err.message; }
  }

  // ── HubSpot: application fee paid → program pipeline ─────────────────────
  if (app.paid_at && !s.hsPaid && paymentSyncOn()) {
    try {
      const res = await applyAppFee(app, schema);
      await setSync(app.id, { hsPaid: ok(res) }, { hubspot_deal_id: res.dealId, ...(res.contactId ? { hubspot_contact_id: res.contactId } : {}) });
      out.hsPaid = "ok";
    } catch (err) { log.error("[sync paid]", err.message); await setSync(app.id, { hsPaidError: fail(err) }); out.hsPaid = err.message; }
  }
  return out;
}

/**
 * Put the deal in the application pipeline ("PD Applications", or
 * HUBSPOT_APPLICATION_PIPELINE) at Application Complete — creating the deal if
 * neither pd-apply nor the Zap has made one yet.
 */
export async function placeInApplicationPipeline(app, schema) {
  const pipes = await HS.dealPipelines();
  const applicant = R.findApplicantPipeline(pipes, process.env.HUBSPOT_APPLICATION_PIPELINE);
  if (!applicant) throw new Error(`No application pipeline in HubSpot (looked for "${process.env.HUBSPOT_APPLICATION_PIPELINE || "PD Applications"}")`);
  const stage = R.findStage(applicant, "applicationComplete") || R.findStage(applicant, "applicationReceived") || applicant.stages?.[0];
  const { contactId, dealId: found } = await resolveHubspot(app, schema);
  const dealId = found || (await createApplicantDeal({ ...app, hubspot_contact_id: contactId }, schema)).id;
  const deal = await HS.getDeal(dealId);
  const p = deal?.properties || {};
  const { facts, pdProgram } = await pdProgramFor(schema, app);
  const update = {
    ...hubspotProps(schema, app.answers || {}, "deal"),
    pipeline: applicant.id,
    dealstage: stage?.id,
    ...(!Number(p.amount) && facts.price != null ? { amount: String(facts.price) } : {}),
    ...(!p.pd_program && pdProgram ? { pd_program: pdProgram } : {}),
    ...(!p.travel_year && facts.year ? { travel_year: String(facts.year) } : {}),
  };
  const r = await HS.updateDeal(dealId, update);
  return { dealId: String(dealId), contactId, pipeline: applicant.label, stage: stage?.label || null, movedFrom: p.pipeline && p.pipeline !== applicant.id ? p.pipeline : undefined, dropped: r.dropped };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function pdProgramFor(schema, app) {
  const facts = K.enrolmentFacts(schema, app.answers || {});
  const options = await HS.propertyOptions("deals", "pd_program").catch(() => []);
  return { facts, pdProgram: R.matchPdProgram(options, facts.program, facts.pdProgram) };
}

async function createApplicantDeal(app, schema) {
  // A deal the Zap (or a previous attempt) already made for this program wins.
  const existing = await findApplicantDeal(app, schema);
  if (existing) return { id: existing.id, reused: true, dropped: [] };
  const pipes = await HS.dealPipelines();
  const applicant = R.findApplicantPipeline(pipes, process.env.HUBSPOT_APPLICATION_PIPELINE);
  const stage = R.findStage(applicant, "applicationReceived") || applicant?.stages?.[0];
  const { facts, pdProgram } = await pdProgramFor(schema, app);
  const props = {
    dealname: `${app.first_name} ${app.last_name} - ${app.program}`.trim(),
    pipeline: applicant?.id,
    dealstage: stage?.id,
    amount: facts.price != null ? String(facts.price) : undefined,
    pd_program: pdProgram || undefined,
    travel_year: facts.year || undefined,
    ...hubspotProps(schema, app.answers || {}, "deal"),
  };
  return HS.createDeal(props, app.hubspot_contact_id);
}

/** Newest open deal for this contact that looks like this application. */
async function findApplicantDeal(app, schema) {
  if (!app.hubspot_contact_id) return null;
  const deals = await HS.contactDeals(app.hubspot_contact_id);
  if (!deals.length) return null;
  const pipes = await HS.dealPipelines();
  const applicant = R.findApplicantPipeline(pipes, process.env.HUBSPOT_APPLICATION_PIPELINE);
  const prog = String(app.program || "").toLowerCase();
  const created = new Date(app.created_at || Date.now()).getTime();
  const recent = (d) => Math.abs(new Date(d.properties?.createdate || 0).getTime() - created) < 1000 * 60 * 60 * 24 * 45;
  const nameHit = (d) => prog && String(d.properties?.dealname || "").toLowerCase().includes(prog.split(" ")[0]);
  return deals.find((d) => applicant && d.properties?.pipeline === applicant.id && recent(d) && nameHit(d))
    || deals.find((d) => applicant && d.properties?.pipeline === applicant.id && recent(d))
    || deals.find((d) => recent(d) && nameHit(d) && !/closed|lost|cancel/i.test(String(d.properties?.dealstage || "")))
    || null;
}

async function resolveHubspot(app, schema) {
  let contactId = app.hubspot_contact_id;
  if (!contactId) {
    const c = await HS.findContactByEmail(app.email);
    contactId = c?.id ? String(c.id) : null;
    if (!contactId) {
      const made = await HS.upsertContact(app.email, { ...hubspotProps(schema, app.answers || {}, "contact"), company_tag: process.env.HUBSPOT_COMPANY_TAG || "Pacific Discovery" });
      contactId = made.id;
    }
    await setSync(app.id, {}, { hubspot_contact_id: contactId });
    app.hubspot_contact_id = contactId;
  }
  let dealId = app.hubspot_deal_id;
  if (!dealId) {
    const d = await findApplicantDeal(app, schema);
    dealId = d?.id ? String(d.id) : null;
  }
  return { contactId, dealId };
}

/**
 * The application-fee move: program pipeline chosen from program type +
 * season, stage "Application Fee Received", PD Program, travel year, and the
 * payment written into the first empty payment_N.
 */
export async function applyAppFee(app, schema) {
  const { contactId, dealId: found } = await resolveHubspot(app, schema);
  let dealId = found;
  if (!dealId) dealId = (await createApplicantDeal({ ...app, hubspot_contact_id: contactId }, schema)).id;
  const deal = await HS.getDeal(dealId);
  const pipes = await HS.dealPipelines();
  const { facts, pdProgram } = await pdProgramFor(schema, app);
  const label = R.targetPipelineLabel(facts.programType, facts.season);
  const pipeline = R.findPipeline(pipes, label);
  const stage = pipeline ? R.findStage(pipeline, "appFee") : null;
  const pay = app.payment || {};
  const update = R.appFeeDealUpdate({
    facts, pipeline: stage ? pipeline : null, stage, pdProgram, dealProps: deal?.properties || {},
    payment: { amount: pay.base ?? 250, reference: pay.reference, date: pay.paidAt || new Date().toISOString() },
  });
  const r = await HS.updateDeal(dealId, update);
  return {
    dealId: String(dealId), contactId, pipeline: pipeline?.label || null, stage: stage?.label || null,
    pdProgram: pdProgram || null, travelYear: facts.year, dropped: r.dropped,
    warning: !pipeline ? `No pipeline for ${facts.programType}/${facts.season}` : !stage ? `No "Application Fee Received" stage in ${pipeline.label}` : undefined,
  };
}

/**
 * Kick off the sync in the background function (15-minute limit), falling
 * back to running it inline if the background call can't be made.
 */
export async function triggerSync(appId, { schema } = {}) {
  const base = (process.env.URL || process.env.APPLY_SITE_URL || "").replace(/\/+$/, "");
  if (base && process.env.APPLY_SERVICE_KEY) {
    try {
      const res = await fetch(`${base}/.netlify/functions/apply-sync-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-apply-key": process.env.APPLY_SERVICE_KEY },
        body: JSON.stringify({ id: appId }),
      });
      if (res.status === 202 || res.ok) return { mode: "background" };
    } catch (err) { console.warn("[triggerSync] background call failed:", err.message); }
  }
  try { return { mode: "inline", result: await syncApplication(appId, { schema }) }; }
  catch (err) { console.error("[triggerSync] inline sync failed:", err.message); return { mode: "inline", error: err.message }; }
}
