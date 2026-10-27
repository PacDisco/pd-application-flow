// After acceptance: the offer, the acceptance page's data, the deposit
// checkout, and recording the deposit (stage 4a).
//
// applications.enrolment (MIGRATION-enrolment.sql):
//   offer     { tuition, paid, deposit, start, end, programRecordId, holdUntil, at }
//             fixed at acceptance — the price they applied at, the start date
//             from the HubSpot program record
//   pending   { plan, method, sessionId, option, termsVersion, agreedAt, at }
//             what they chose on the acceptance page, while Stripe takes payment
//   choice    { plan, method, termsVersion, agreedAt }   once paid
//   deposit   { amount, fee, total, reference, method, paidAt, status }
//   schedule  [{ due, amount, kind: deposit|instalment|balance, manual?, status }]
//   stripe    { customer, paymentMethod }               for automatic instalments
//   emails    { accepted, enrolled }
//
// Automatic instalment charging is the next release (4b): the schedule and the
// saved payment method recorded here are what it charges.

import { db } from "./db.mjs";
import { siteUrl } from "./http.mjs";
import * as A from "./applications.mjs";
import * as HS from "./hubspot.mjs";
import * as R from "./routing.mjs";
import * as K from "../../../public/form-kit.mjs";
import * as P from "../../../public/plans-kit.mjs";
import * as TK from "../../../public/terms-kit.mjs";
import { createDepositCheckout, getCheckoutSession, getPaymentIntent } from "./stripe.mjs";
import { mailOn, alertOn, sendEnrolled, sendDepositAlert } from "./notify.mjs";
import { logFamilyEmail, hubspotOn } from "./email-log.mjs";
import { publishedTermsOrNull } from "./terms.mjs";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const DAY = 864e5;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function readEnrolment(id) {
  const rows = await db().query(`SELECT enrolment, decision FROM applications WHERE id = $1`, [id]);
  return { enrolment: rows[0]?.enrolment || {}, decision: rows[0]?.decision || null };
}

/** Shallow-merge keys into applications.enrolment. */
export async function patchEnrolment(id, patch) {
  await db().query(
    `UPDATE applications SET enrolment = COALESCE(enrolment, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(patch)]);
}

/** The departure's start (and end) date from its HubSpot program record. */
export async function programDates(app) {
  let recordId = app.sync?.hsProgram?.record?.id || null;
  if (!recordId && hubspotOn()) {
    const records = await HS.programRecords(R.PROGRAM_OBJECT_TYPE);
    const m = R.matchProgramRecord(records, { program: app.program, programType: app.program_type, season: app.season, year: app.travel_year });
    recordId = m.record?.id || null;
  }
  if (!recordId) return { start: null, end: null, recordId: null };
  const rec = await HS.hs(`/crm/v3/objects/${R.PROGRAM_OBJECT_TYPE}/${recordId}?properties=program_start_date,program_end_date`);
  const d = (v) => (v ? String(v).slice(0, 10) : null);
  return { start: d(rec?.properties?.program_start_date), end: d(rec?.properties?.program_end_date), recordId: String(recordId) };
}

/**
 * The offer, fixed at acceptance. Throws (so Accept is refused with the
 * reason) when there's no price or no start date to build a schedule from.
 */
export async function makeOffer(app, schema, { holdDays, now = new Date() } = {}) {
  const tuition = Number(app.deal_amount) || Number(K.programByName(schema, app.program)?.price) || 0;
  if (!tuition) throw bad(`No program price for ${app.program} — set it in Programs & dates first.`, 409);
  const dates = await programDates(app);
  if (!dates.start) throw bad(`No start date for ${app.program} ${app.term || ""} — the HubSpot program record needs a Program Start Date before this applicant can be accepted.`.replace(/\s+—/, " —"), 409);
  if (P.day(dates.start) <= P.day(now)) throw bad("This departure has already started.", 409);
  const paid = app.paid_at ? Number(app.payment?.base ?? 250) : 0;
  return {
    tuition, paid, deposit: P.depositFor(paid), discounts: planDiscounts(schema, app),
    start: dates.start, end: dates.end, programRecordId: dates.recordId,
    holdUntil: new Date(now.getTime() + holdDays * DAY).toISOString(), at: now.toISOString(),
  };
}

/** Program kind for the pay-in-full discount: semester | mini | summer. */
export function programKind(schema, app) {
  const t = K.programByName(schema, app.program)?.type || app.program_type || "";
  if (/mini/i.test(t) || /mini/i.test(app.program || "")) return "mini";
  if (/summer/i.test(t) || /summer/i.test(app.program || "")) return "summer";
  return "semester";
}

/**
 * Plan discounts for this applicant now (dashboard → Acceptance & deposit):
 * { full, two } in dollars by program kind. settings.discounts =
 * { enabled, full: { semester, mini, summer }, two: { … } } (the first
 * version stored pay-in-full only, as settings.payInFull).
 */
export function planDiscounts(schema, app) {
  const st = schema?.settings || {};
  const d = st.discounts || (st.payInFull ? { enabled: st.payInFull.enabled, full: st.payInFull } : null);
  if (!d?.enabled) return { full: 0, two: 0 };
  const kind = programKind(schema, app);
  const amt = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
  return { full: amt(d.full?.[kind]), two: amt(d.two?.[kind]) };
}
/** Pay-in-full discount alone (kept for callers of the first version). */
export const payInFullDiscount = (schema, app) => planDiscounts(schema, app).full;

export function acceptLink(token) {
  return `${siteUrl()}/accept?token=${encodeURIComponent(token)}`;
}

/** What the acceptance page shows. Pure apart from `now`. */
export function offerView(app, { enrolment = {}, decision = null } = {}, schema, terms, now = new Date()) {
  const base = {
    firstName: app.answers?.preferredName || app.first_name || "",
    name: `${app.first_name || ""} ${app.last_name || ""}`.trim(),
    email: app.email, program: app.program, term: app.term,
    advisor: TK.advisorBlock(schema),
  };
  if (decision?.outcome === "declined") return { ...base, state: "declined" };
  if (enrolment.deposit?.status === "paid" || enrolment.deposit?.status === "processing") {
    return {
      ...base, state: "enrolled", processing: enrolment.deposit.status === "processing",
      plan: enrolment.choice?.plan, planName: PLAN_LABEL[enrolment.choice?.plan] || "", method: enrolment.choice?.method,
      schedule: (enrolment.schedule || []).map((p) => ({ due: p.due, amount: p.amount, kind: p.kind, manual: !!p.manual, status: p.status, total: p.total ?? null, paidAt: p.paidAt || null })),
      deposit: { status: enrolment.deposit.status, total: enrolment.deposit.total, method: enrolment.deposit.method },
      start: enrolment.offer?.start,
      termsVersion: enrolment.choice?.termsVersion || null,
      // what they'd be charged: the rate they agreed to for their method, today's for the other
      rates: { ...K.surchargeRates(schema), ...(enrolment.choice?.rate != null ? { [enrolment.choice.method === "ach" ? "ach" : "card"]: Number(enrolment.choice.rate) } : {}) },
      withdrawn: !!enrolment.withdrawn,
      // pay off everything left in one go
      rest: enrolment.deposit.status === "paid" && !enrolment.withdrawn
        ? Math.round((enrolment.schedule || []).filter((p, i) => i > 0 && ["scheduled", "failed", "needs_admissions", "due"].includes(p.status)).reduce((a, p) => a + p.amount * 100, 0)) / 100
        : 0,
      // can change the saved card / bank account while automatic payments remain
      canUpdateMethod: !enrolment.withdrawn && (enrolment.schedule || []).some((p) => !p.manual && ["scheduled", "failed", "needs_admissions"].includes(p.status)),
    };
  }
  if (decision?.outcome !== "accepted" || !enrolment.offer) return { ...base, state: "none" };
  // What's been paid toward it can change after acceptance (the fee paid late),
  // so it's worked out now rather than taken from the stored offer.
  const paidNow = app.paid_at ? Number(app.payment?.base ?? 250) : 0;
  const o = { ...enrolment.offer, paid: paidNow, deposit: P.depositFor(paidNow) };
  const holdUntil = decision.holdUntil || o.holdUntil;
  const expired = holdUntil && new Date(holdUntil) < now;
  // Discounts: what they were offered at acceptance, or today's settings if
  // those are better (a discount added after they were accepted still applies;
  // lowering one never takes back what they were told).
  const fixed = o.discounts || { full: o.payInFullDiscount || 0, two: 0 };
  const live = planDiscounts(schema, app);
  const discounts = { full: Math.max(fixed.full || 0, live.full), two: Math.max(fixed.two || 0, live.two) };
  const opts = P.paymentOptions({ tuition: o.tuition, paid: o.paid, deposit: o.deposit, start: o.start, today: P.iso(now), discounts });
  const rates = K.surchargeRates(schema);
  return {
    ...base, state: expired ? "expired" : "offer",
    tuition: o.tuition, paid: o.paid, deposit: o.deposit, start: o.start, end: o.end, holdUntil,
    balance: opts.balance, daysToStart: opts.daysToStart, options: opts.options, rates,
    terms: terms ? { version: terms.version, title: terms.title, url: `${siteUrl()}/terms?v=${terms.version}` } : null,
  };
}

const PLAN_LABEL = { monthly: "Monthly payments", two: "Two instalments", full: "Paid in full", later: "Deposit now, balance later" };

/** Start Stripe Checkout for the chosen option. Returns { url }. */
export async function startCheckout(app, { plan, method, agree, token }, schema, now = new Date()) {
  const { enrolment, decision } = await readEnrolment(app.id);
  const terms = await publishedTermsOrNull();
  const view = offerView(app, { enrolment, decision }, schema, terms, now);
  if (view.state === "enrolled") throw bad("Your place is already confirmed.", 409);
  if (view.state === "expired") throw bad("The hold on your place has passed. Please contact admissions — they can extend it.", 409);
  if (view.state !== "offer") throw bad("There's no offer to confirm on this application.", 409);
  if (!agree) throw bad("Please agree to the Program Terms & Conditions to continue.");
  if (!["card", "ach"].includes(method)) throw bad("Choose card or bank account.");
  const option = view.options.find((o) => o.key === plan);
  if (!option) throw bad("That payment option isn't available.");
  const rate = view.rates[method];
  const charge = P.todayCharge(option, rate);
  const program = app.program || "Pacific Discovery";
  const what = plan === "full" ? `Tuition in full — ${program}${option.discount ? ` (after $${option.discount.toLocaleString("en-US")} pay-in-full discount)` : ""}`
    : option.payments[0].amount > view.deposit ? `Deposit + first instalment — ${program}` : `Deposit — ${program}`;
  const ret = acceptLink(token);
  const currency = String(schema.settings?.currency || "usd").toLowerCase();
  const session = await createDepositCheckout({
    app, currency, method,
    lines: [[what, charge.base], [method === "ach" ? `Bank payment fee (${(rate * 100).toFixed(1).replace(/\.0$/, "")}%)` : `Card processing fee (${(rate * 100).toFixed(1).replace(/\.0$/, "")}%)`, charge.fee]],
    save: option.payments.some((p) => p.kind === "instalment"),
    successUrl: `${ret}&paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ret}&cancelled=1`,
    description: `${what} — ${app.first_name || ""} ${app.last_name || ""}`.trim(),
    metadata: {
      payment_kind: "deposit", plan, method, base_amount: charge.base, processing_fee: charge.fee, charge_amount: charge.total,
      processing_fee_rate: rate, terms_version: terms?.version || "", program: program.slice(0, 200), travel_term: app.term || "",
      ...(app.hubspot_deal_id ? { deal_id: app.hubspot_deal_id } : {}),
    },
  });
  await patchEnrolment(app.id, {
    pending: { plan, method, sessionId: session.id, option, rate, charge, termsVersion: terms?.version || null, agreedAt: now.toISOString(), at: now.toISOString() },
  });
  return { url: session.url };
}

/**
 * Record a deposit checkout (return page or webhook — idempotent). For ACH,
 * Stripe reports "processing" first and the money lands days later
 * (checkout.session.async_payment_succeeded); the place is confirmed then.
 * Returns { first, enrolment }.
 */
export async function recordDeposit(session, schema, { log = console } = {}) {
  const app = await A.byId(session.client_reference_id);
  if (!app) return { first: false };
  const { enrolment } = await readEnrolment(app.id);
  const choice = [enrolment.pending, enrolment.lastPending].find((c) => c?.sessionId === session.id);
  if (!choice) { log.warn?.("[enrol] unknown deposit session", session.id); return { first: false }; }
  const status = session.payment_status === "paid" ? "paid"
    : session.status === "complete" && session.payment_status === "unpaid" ? "processing" : null;
  if (!status) return { first: false };
  if (enrolment.deposit?.sessionId === session.id && (enrolment.deposit.status === status || enrolment.deposit.status === "paid")) return { first: false, enrolment };

  let paymentMethod = null;
  try { paymentMethod = session.payment_intent ? (await getPaymentIntent(session.payment_intent))?.payment_method || null : null; } catch { /* not needed to confirm the place */ }
  const schedule = choice.option.payments.map((p, i) => ({ ...p, status: i === 0 ? status : p.manual ? "due" : "scheduled" }));
  const deposit = {
    amount: choice.charge.base, fee: choice.charge.fee, total: choice.charge.total, method: choice.method,
    reference: session.payment_intent || session.id, sessionId: session.id, status, paidAt: new Date().toISOString(),
    ...(choice.option?.discount ? { discount: choice.option.discount, discountPlan: choice.plan } : {}),
  };
  const patch = {
    choice: { plan: choice.plan, method: choice.method, rate: choice.rate ?? null, termsVersion: choice.termsVersion, agreedAt: choice.agreedAt },
    deposit, schedule, stripe: { customer: session.customer || null, paymentMethod: paymentMethod ? (paymentMethod.id || String(paymentMethod)) : null },
    pending: null, lastPending: choice,
  };
  // Atomic: only one caller (return page or webhook) moves it to "paid", so the
  // family is emailed once.
  const rows = await db().query(
    `UPDATE applications SET enrolment = COALESCE(enrolment, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE id = $1 AND COALESCE(enrolment->'deposit'->>'status', '') <> 'paid' RETURNING id`,
    [app.id, JSON.stringify(patch)]);
  const now = { ...enrolment, ...patch };
  if (!rows.length || status !== "paid") return { first: false, enrolment: now };

  // ── confirmed: HubSpot, the family, admissions ─────────────────────────
  const emails = { ...(enrolment.emails || {}) };
  if (hubspotOn() && app.hubspot_deal_id) {
    try {
      const deal = await HS.getDeal(app.hubspot_deal_id);
      const pipes = await HS.dealPipelines();
      const pipe = pipes.find((p) => p.id === String(deal?.properties?.pipeline));
      const st = R.findStage(pipe, "depositPaid");
      const props = {};
      if (st && R.isForward(pipe, deal?.properties?.dealstage, st)) props.dealstage = st.id;
      const slot = R.choosePaymentSlot(deal?.properties || {}, deposit.reference);
      if (slot) props[slot] = R.paymentEntry(deposit.amount, deposit.reference, deposit.paidAt);
      // Plan discount: the deal's amount becomes what they actually owe,
      // so the portal (and reporting) don't show the discount as still due.
      if (deposit.discount && enrolment.offer?.tuition) props.amount = String(Math.round((enrolment.offer.tuition - deposit.discount) * 100) / 100);
      if (Object.keys(props).length) await HS.updateDeal(app.hubspot_deal_id, props);
      const plan = PLAN_LABEL[choice.plan];
      const rows = schedule.filter((p) => p.kind !== "deposit").map((p) => `<li>${esc(p.due)} — $${p.amount.toFixed(2)}${p.manual ? " (to pay by this date)" : " (automatic)"}</li>`).join("");
      await HS.addNote(`<p><strong>Place confirmed</strong> — paid $${deposit.total.toFixed(2)} by ${choice.method === "ach" ? "bank account" : "card"} (${esc(deposit.reference)}). Plan: ${esc(plan)}${deposit.discount ? ` with the $${deposit.discount.toLocaleString("en-US")} ${choice.plan === "two" ? "two-instalment (off the final payment)" : "pay-in-full"} discount (deal amount set to $${(enrolment.offer.tuition - deposit.discount).toLocaleString("en-US")})` : ""}. Terms v${esc(choice.termsVersion || "?")} agreed ${esc(choice.agreedAt)}.</p>${rows ? `<ul>${rows}</ul>` : ""}`,
        { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id });
      patch.hubspot = { ok: true, stage: props.dealstage ? st.label : null };
    } catch (err) { log.error?.("[enrol hubspot]", err.message); patch.hubspot = { ok: false, error: String(err.message).slice(0, 300) }; }
  }
  if (mailOn() && TK.emailTemplate(schema, "enrolled").enabled) {
    try {
      const terms = await publishedTermsOrNull(choice.termsVersion ? { version: choice.termsVersion } : {});
      const msg = await sendEnrolled(app, schema, { enrolment: now, terms });
      emails.enrolled = { to: msg.to, at: new Date().toISOString(), hubspot: await logFamilyEmail(app, msg) };
    } catch (err) { log.error?.("[enrol email]", err.message); emails.enrolled = { error: String(err.message).slice(0, 300) }; }
  }
  if (alertOn()) { try { await sendDepositAlert(app, now); } catch (err) { log.error?.("[enrol alert]", err.message); } }
  await patchEnrolment(app.id, { emails, ...(patch.hubspot ? { hubspot: patch.hubspot } : {}) });
  return { first: true, enrolment: { ...now, emails } };
}

/** The return page: confirm the session with Stripe and record it. */
export async function confirmReturn(app, sessionId, schema) {
  const { enrolment } = await readEnrolment(app.id);
  if (!sessionId || ![enrolment.pending?.sessionId, enrolment.lastPending?.sessionId].includes(sessionId)) return;
  const s = await getCheckoutSession(sessionId);
  if (s?.client_reference_id === app.id) await recordDeposit(s, schema);
}

/** A bank (ACH) deposit that bounced: back to the offer so they can pay again; admissions told. */
export async function depositFailed(session, schema, { log = console } = {}) {
  const app = await A.byId(session.client_reference_id);
  if (!app) return;
  const { enrolment } = await readEnrolment(app.id);
  if (enrolment.deposit?.sessionId !== session.id || enrolment.deposit.status === "paid") return;
  await patchEnrolment(app.id, { deposit: { ...enrolment.deposit, status: "failed", failedAt: new Date().toISOString() } });
  if (hubspotOn()) {
    try { await HS.addNote(`<p><strong>Deposit bank payment failed</strong> (${esc(enrolment.deposit.reference)}). The family can pay again from their acceptance link.</p>`, { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id }); }
    catch (err) { log.error?.("[enrol failed note]", err.message); }
  }
}
