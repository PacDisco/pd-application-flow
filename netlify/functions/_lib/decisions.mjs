// Admissions decisions, made in the dashboard (Applications → Accept / Decline)
// and carried out here because this site holds the Stripe and email setup.
//
//   accepted   the place is held for holdDays (default 7) for the $2,250
//              deposit. The deal moves to an "Accepted" stage when its pipeline
//              has one. The acceptance email and deposit page come with the
//              payment-plan release.
//   declined   the application fee is refunded through Stripe (when asked —
//              the default unless they had already been accepted), the family
//              gets the "not accepted" email, and the deal moves to a declined /
//              closed-lost stage when there is one.
//
// The refund runs FIRST: if Stripe refuses, nothing else happens and the
// dashboard shows why. A retry can't refund twice (Stripe idempotency key).
// Everything after the refund is recorded and best-effort.
//
// Stored in applications.decision (MIGRATION-decisions.sql):
//   { outcome, at, by, message, holdUntil?, refund?, email?, hubspot?, history: [earlier decisions] }

import { db } from "./db.mjs";
import * as A from "./applications.mjs";
import * as HS from "./hubspot.mjs";
import * as R from "./routing.mjs";
import { refundPayment } from "./stripe.mjs";
import { mailOn, sendDeclined, sendAccepted } from "./notify.mjs";
import { makeOffer, patchEnrolment, acceptLink } from "./enrol.mjs";
import { publishedTermsOrNull } from "./terms.mjs";
import { logFamilyEmail, hubspotOn } from "./email-log.mjs";
import { holdDays, emailTemplate } from "../../../public/terms-kit.mjs";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function readDecision(id) {
  const rows = await db().query(`SELECT decision FROM applications WHERE id = $1`, [id]);
  const d = rows[0]?.decision || null;
  return d && d.outcome ? d : null;
}

/** Only one decision at a time per application (a double click can't email twice). */
async function claim(id) {
  const rows = await db().query(
    `UPDATE applications SET decision = COALESCE(decision, '{}'::jsonb) || jsonb_build_object('pending', now())
      WHERE id = $1 AND (decision IS NULL OR NOT (decision ? 'pending') OR (decision->>'pending')::timestamptz < now() - interval '2 minutes')
      RETURNING id`, [id]);
  return rows.length > 0;
}

async function unclaim(id) {
  await db().query(`UPDATE applications SET decision = NULLIF(decision - 'pending', '{}'::jsonb) WHERE id = $1`, [id]);
}

async function writeDecision(id, decision) {
  await db().query(`UPDATE applications SET decision = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(decision)]);
}

async function moveDeal(app, kind, schema) {
  if (!hubspotOn() || !app.hubspot_deal_id) return null;
  const deal = await HS.getDeal(app.hubspot_deal_id);
  const pipes = await HS.dealPipelines();
  const pipe = pipes.find((p) => p.id === String(deal?.properties?.pipeline));
  const st = R.findStage(pipe, kind);
  // Accepted before paying the fee: the deal is still in "PD Applications",
  // which has no such stage — move it into the program's pipeline.
  if (!st && kind === "accepted") {
    const moved = await A.moveToProgramPipeline(app, schema, "accepted", deal);
    if (moved) return moved;
  }
  const move = st && R.isForward(pipe, deal?.properties?.dealstage, st);
  if (move) await HS.updateDeal(app.hubspot_deal_id, { dealstage: st.id });
  return { pipeline: pipe?.label || null, stage: move ? st.label : null };
}

/**
 * Carry out a decision. Returns the stored decision.
 *   outcome  "accepted" | "declined"
 *   refund   decline only: refund the application fee (default true unless
 *            they had been accepted, when the fee is non-refundable)
 */
export async function decide(appId, { outcome, by = "admissions", message = "", refund } = {}, { schema, log = console, now = new Date() } = {}) {
  if (!["accepted", "declined"].includes(outcome)) throw bad("Decision must be accepted or declined.");
  const app = await A.byId(appId);
  if (!app) throw bad("Application not found.", 404);
  if (app.status === "withdrawn") throw bad("This application is withdrawn. Restore it first.", 409);

  if (!(await claim(app.id))) throw bad("Another decision for this application is being saved. Try again in a moment.", 409);
  try {
    // Read the current decision only once we hold the claim, so two clicks
    // can't both see "no decision yet".
    const prev = await readDecision(app.id);
    if (prev?.outcome === outcome) throw bad(`Already ${outcome}.`, 409);
    if (prev?.outcome === "declined") throw bad("This application was declined. Declines can't be undone here — contact the family directly.", 409);
    return await carryOut(app, prev, { outcome, by, message, refund }, { schema, log, now });
  } catch (err) {
    await unclaim(app.id);
    throw err;
  }
}

async function carryOut(app, prev, { outcome, by, message, refund }, { schema, log, now }) {
  const note = String(message || "").trim().slice(0, 2000);
  const decision = {
    outcome, at: now.toISOString(), by: String(by).slice(0, 120), message: note || null,
    history: prev ? [...(prev.history || []), { ...prev, history: undefined }] : [],
  };

  if (outcome === "accepted") {
    // The offer (price + start date) is fixed now; no start date → refused.
    decision.offer = await makeOffer(app, schema, { holdDays: holdDays(schema), now });
    decision.holdUntil = decision.offer.holdUntil;
  } else {
    // Refund first. Default: refund, unless they were accepted (then the fee
    // is non-refundable under the terms) — admissions can override either way.
    const wantRefund = refund === undefined ? prev?.outcome !== "accepted" : !!refund;
    // Only a fee paid by Stripe through pd-apply can be refunded here (an
    // imported applicant's fee was paid another way).
    if (wantRefund && app.paid_at && /^pi_/.test(String(app.payment?.reference || ""))) {
      const r = await refundPayment(app.payment?.reference, {
        key: `pd-apply-decline-${app.id}`,
        metadata: { application_id: app.id, source: "pd-apply", reason: "application not accepted" },
      });
      decision.refund = { id: r.id, amount: r.amount, status: r.status, at: now.toISOString() };
    }
  }

  await writeDecision(app.id, decision);

  // ── after the decision is stored: email, HubSpot (best-effort, recorded) ──
  if (outcome === "accepted") {
    try { await patchEnrolment(app.id, { offer: decision.offer }); }
    catch (err) {
      // e.g. MIGRATION-enrolment.sql not run: no acceptance page without it.
      log.error?.("[decision offer]", err.message);
      decision.offerError = String(err.message).slice(0, 300);
    }
    if (!decision.offerError && mailOn() && emailTemplate(schema, "accepted").enabled) decision.email = await acceptanceEmail(app, decision, schema, log);
  }
  if (outcome === "declined" && mailOn() && emailTemplate(schema, "declined").enabled) {
    try {
      const msg = await sendDeclined(app, schema, { message: note, refund: decision.refund });
      decision.email = { to: msg.to, at: new Date().toISOString(), hubspot: await logFamilyEmail(app, msg) };
    } catch (err) {
      log.error?.("[decision email]", err.message);
      decision.email = { error: String(err.message).slice(0, 300), at: new Date().toISOString() };
    }
  }
  if (hubspotOn()) {
    try {
      const moved = await moveDeal(app, outcome, schema);
      const lines = outcome === "accepted"
        ? [`<p><strong>Accepted</strong> by ${esc(decision.by)}. Place held until ${esc(new Date(decision.holdUntil).toDateString())} for the $${Number(decision.offer.deposit).toLocaleString("en-US")} deposit${app.paid_at ? "" : " (application fee not paid, so it's included)"}. Tuition $${Number(decision.offer.tuition).toLocaleString("en-US")}, starts ${esc(decision.offer.start)}.${decision.email?.to ? " Acceptance email sent." : ""}</p>`]
        : [`<p><strong>Not accepted</strong> — decided by ${esc(decision.by)}.</p>`,
          decision.refund ? `<p>Application fee refunded: $${(decision.refund.amount / 100).toFixed(2)} (Stripe ${esc(decision.refund.id)}).</p>` : "<p>Application fee not refunded.</p>"];
      if (note) lines.push(`<p>Message to the family: ${esc(note)}</p>`);
      await HS.addNote(lines.join(""), { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id });
      decision.hubspot = { ok: true, ...(moved || {}) };
    } catch (err) {
      log.error?.("[decision hubspot]", err.message);
      decision.hubspot = { ok: false, error: String(err.message).slice(0, 300) };
    }
  }
  await writeDecision(app.id, decision);
  return decision;
}

async function acceptanceEmail(app, decision, schema, log = console) {
  try {
    const token = await A.addLinkToken(app.id);
    const link = acceptLink(token);
    const terms = await publishedTermsOrNull();
    const msg = await sendAccepted(app, schema, { offer: decision.offer, link, terms, message: decision.message });
    // The logged copy must not carry the personal link (it signs them in).
    const scrub = (x) => String(x || "").split(link).join(acceptLink("")).split(link.replace(/&/g, "&amp;")).join(acceptLink(""));
    return { to: msg.to, at: new Date().toISOString(), hubspot: await logFamilyEmail(app, { ...msg, text: scrub(msg.text), html: scrub(msg.html) }) };
  } catch (err) {
    log.error?.("[decision email]", err.message);
    return { error: String(err.message).slice(0, 300), at: new Date().toISOString() };
  }
}

/**
 * Admissions: send the acceptance email (again) — when it failed, never went,
 * or the family lost it. Re-creates the offer for the acceptance page if it's
 * missing. Each send has a fresh personal link; earlier links keep working.
 */
export async function resendAcceptance(appId, { by = "admissions" } = {}, { schema, log = console, now = new Date() } = {}) {
  const app = await A.byId(appId);
  if (!app) throw bad("Application not found.", 404);
  const d = await readDecision(app.id);
  if (d?.outcome !== "accepted") throw bad("This application hasn't been accepted.", 409);
  if (!mailOn()) throw bad("Email isn't set up on pd-apply (SMTP_USER / SMTP_PASS).", 500);
  const next = { ...d };
  if (!next.offer) {
    next.offer = await makeOffer(app, schema, { holdDays: holdDays(schema), now });
    next.holdUntil = next.offer.holdUntil;
  }
  // A hold that has already passed is extended so the link works when it arrives.
  if (next.holdUntil && new Date(next.holdUntil) < now) {
    next.holdUntil = new Date(now.getTime() + holdDays(schema) * 864e5).toISOString();
    next.offer = { ...next.offer, holdUntil: next.holdUntil };
  }
  await patchEnrolment(app.id, { offer: next.offer });
  delete next.offerError;
  next.email = await acceptanceEmail(app, next, schema, log);
  if (next.email.error) { await writeDecision(app.id, next); throw bad(`Email not sent: ${next.email.error}`, 502); }
  next.resent = [...(d.resent || []), { at: now.toISOString(), by: String(by).slice(0, 120) }];
  if (hubspotOn()) {
    try { await HS.addNote(`<p><strong>Acceptance email sent</strong> by ${esc(by)} to ${esc(next.email.to.join(", "))}. Place held until ${esc(new Date(next.holdUntil).toDateString())}.</p>`, { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id }); }
    catch (err) { log.error?.("[resend note]", err.message); }
  }
  await writeDecision(app.id, next);
  return next;
}

/** Admissions extends the hold on an accepted applicant's place (default 7 more days from now). */
export async function extendHold(appId, { days = 7, by = "admissions" } = {}, { now = new Date() } = {}) {
  const app = await A.byId(appId);
  if (!app) throw bad("Application not found.", 404);
  const d = await readDecision(app.id);
  if (d?.outcome !== "accepted") throw bad("Only an accepted application has a hold to extend.", 409);
  const n = Math.max(1, Math.min(60, Math.round(Number(days) || 7)));
  // n days from today — never shorter than the hold they already have.
  const current = Date.parse(d.holdUntil || "") || 0;
  const holdUntil = new Date(Math.max(current, now.getTime() + n * 864e5)).toISOString();
  const next = { ...d, holdUntil, offer: d.offer ? { ...d.offer, holdUntil } : d.offer, extended: [...(d.extended || []), { at: now.toISOString(), by, holdUntil }] };
  await writeDecision(app.id, next);
  if (d.offer) await patchEnrolment(app.id, { offer: next.offer });
  return next;
}
