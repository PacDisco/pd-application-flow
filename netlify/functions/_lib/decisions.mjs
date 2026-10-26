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
import { mailOn, sendDeclined } from "./notify.mjs";
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

async function moveDeal(app, kind) {
  if (!hubspotOn() || !app.hubspot_deal_id) return null;
  const deal = await HS.getDeal(app.hubspot_deal_id);
  const pipes = await HS.dealPipelines();
  const pipe = pipes.find((p) => p.id === String(deal?.properties?.pipeline));
  const st = R.findStage(pipe, kind);
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
  if (outcome === "accepted" && !app.paid_at) throw bad("The application fee hasn't been paid yet.", 409);

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
    decision.holdUntil = new Date(now.getTime() + holdDays(schema) * 864e5).toISOString();
  } else {
    // Refund first. Default: refund, unless they were accepted (then the fee
    // is non-refundable under the terms) — admissions can override either way.
    const wantRefund = refund === undefined ? prev?.outcome !== "accepted" : !!refund;
    if (wantRefund && app.paid_at) {
      const r = await refundPayment(app.payment?.reference, {
        key: `pd-apply-decline-${app.id}`,
        metadata: { application_id: app.id, source: "pd-apply", reason: "application not accepted" },
      });
      decision.refund = { id: r.id, amount: r.amount, status: r.status, at: now.toISOString() };
    }
  }

  await writeDecision(app.id, decision);

  // ── after the decision is stored: email, HubSpot (best-effort, recorded) ──
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
      const moved = await moveDeal(app, outcome);
      const lines = outcome === "accepted"
        ? [`<p><strong>Accepted</strong> by ${esc(decision.by)}. Place held until ${esc(new Date(decision.holdUntil).toDateString())} for the $2,250 deposit.</p>`]
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
