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
import { createDepositCheckout, createSetupCheckout, getCheckoutSession, getPaymentIntent, getSetupIntent } from "./stripe.mjs";
import { mailOn, alertOn, sendEnrolled, sendDepositAlert, sendFamily, sendAdmissionsAlert, formatUsd } from "./notify.mjs";
import { logFamilyEmail, hubspotOn } from "./email-log.mjs";
import { publishedTermsOrNull } from "./terms.mjs";
import { dealPaid } from "./deal-paid.mjs";

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
  const paid = paidSoFar(app, {}, (await dealPaid(app, { fresh: true }))?.total);
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
/**
 * The discounts this family can have: what they were offered at acceptance,
 * or today's settings if those are better (a discount added after they were
 * accepted still applies; lowering one never takes back what they were told).
 */
export function familyDiscounts(app, enrolment, schema) {
  const o = enrolment?.offer || {};
  const fixed = o.discounts || { full: o.payInFullDiscount || 0, two: 0 };
  const live = planDiscounts(schema, app);
  return { full: Math.max(Number(fixed.full) || 0, live.full), two: Math.max(Number(fixed.two) || 0, live.two) };
}

const OPEN_ITEMS = ["scheduled", "failed", "needs_admissions", "due"];
/** Left to pay after the deposit (open schedule items), in dollars. */
export const restOf = (enrolment) => Math.round((enrolment?.schedule || []).filter((p, i) => i > 0 && OPEN_ITEMS.includes(p.status)).reduce((a, p) => a + Math.round(p.amount * 100), 0)) / 100;

/**
 * A family on "deposit now, balance later" who pays the balance before the
 * discounts end gets the pay-in-full saving. Choosing monthly or two
 * instalments is final: no pay-in-full saving after that.
 * → { amount, rest, pay, until } or null. Pure apart from `now`.
 */
export function payOffSaving(app, enrolment, schema, now = new Date()) {
  const e = enrolment || {};
  if (e.deposit?.status !== "paid" || e.withdrawn || e.payOff) return null;
  if (e.choice?.plan !== "later" || !e.offer?.start) return null;
  // The balance is due before the discounts end (90 vs 60 days out), so its due date is the deadline.
  const due = (e.schedule || []).find((p, i) => i > 0 && p.manual && OPEN_ITEMS.includes(p.status))?.due;
  const last = P.discountLastDay(e.offer.start);
  const until = due && due < last ? due : last;
  if (P.iso(now) > until) return null;
  const rest = restOf(e);
  if (rest <= 0) return null;
  const already = e.deposit?.discountPlan === "two" ? Number(e.deposit.discount) || 0 : 0;
  const cents = Math.min(Math.round(rest * 100), Math.max(0, Math.round((familyDiscounts(app, e, schema).full - already) * 100)));
  if (cents <= 0) return null;
  return { amount: cents / 100, rest, pay: (Math.round(rest * 100) - cents) / 100, until };
}

/** Pay-in-full discount alone (kept for callers of the first version). */
export const payInFullDiscount = (schema, app) => planDiscounts(schema, app).full;

/**
 * Paid toward tuition so far: the most of what pd-apply recorded (the fee),
 * what admissions marked paid, and what the HubSpot deal's payment fields say.
 */
export function paidSoFar(app, enrolment = {}, dealTotal = null) {
  const fee = app?.paid_at ? Number(app.payment?.base ?? 250) : 0;
  return Math.max(fee, Number(enrolment?.prepaid?.total) || 0, Number(dealTotal) || 0);
}

/** Lives outside the US (home country on the application) → bank transfer is offered up front. */
export function isInternational(app) {
  const a = app?.answers || {};
  const c = String(a.homeCountry || a.homeAddress?.country || "").trim();
  return !!c && !/^(united states( of america)?|usa?|u\.s\.a?\.?)$/i.test(c);
}

/** What the family writes as the transfer reference, so it can be matched. */
export const wireReference = (app) => `${app.first_name || ""} ${app.last_name || ""}`.trim().replace(/\s+/g, " ").slice(0, 40) + " - Pacific Discovery";

export function acceptLink(token) {
  return `${siteUrl()}/accept?token=${encodeURIComponent(token)}`;
}

/** What the acceptance page shows. Pure apart from `now`. */
export function offerView(app, { enrolment = {}, decision = null, dealTotal = null } = {}, schema, terms, now = new Date()) {
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
      rest: enrolment.deposit.status === "paid" && !enrolment.withdrawn ? restOf(enrolment) : 0,
      // paying it all now, before the discounts end, earns the pay-in-full saving
      payOff: payOffSaving(app, enrolment, schema, now),
      // paid the deposit by bank transfer: the details again, for the balance
      wire: enrolment.wire && TK.wireDetails(schema) && (enrolment.schedule || []).some((p, i) => i > 0 && p.manual && p.status === "due")
        ? { ...TK.wireDetails(schema), reference: enrolment.wire.reference || wireReference(app) } : null,
      // can change the saved card / bank account while automatic payments remain
      canUpdateMethod: !enrolment.withdrawn && (enrolment.schedule || []).some((p) => !p.manual && ["scheduled", "failed", "needs_admissions"].includes(p.status)),
    };
  }
  if (decision?.outcome !== "accepted" || !enrolment.offer) return { ...base, state: "none" };
  // What's been paid toward it can change after acceptance (the fee paid late),
  // so it's worked out now rather than taken from the stored offer.
  // Already paid (fee, deposit, more) from pd-apply, admissions or the HubSpot
  // deal. Once the deposit is in they only choose how to pay the rest.
  const paidNow = paidSoFar(app, enrolment, dealTotal);
  const prepaid = paidNow >= P.DEPOSIT_TOTAL ? paidNow : 0;
  const o = { ...enrolment.offer, paid: paidNow, deposit: P.depositFor(paidNow) };
  const holdUntil = decision.holdUntil || o.holdUntil;
  const expired = !prepaid && holdUntil && new Date(holdUntil) < now;
  // Discounts: what they were offered at acceptance, or today's settings if
  // those are better (a discount added after they were accepted still applies;
  // lowering one never takes back what they were told).
  const discounts = familyDiscounts(app, enrolment, schema);
  const opts = P.paymentOptions({ tuition: o.tuition, paid: o.paid, deposit: o.deposit, start: o.start, today: P.iso(now), discounts });
  const rates = K.surchargeRates(schema);
  const saving = opts.options.some((x) => x.discount);
  return {
    ...base, state: expired ? "expired" : "offer",
    tuition: o.tuition, paid: o.paid, deposit: o.deposit, start: o.start, end: o.end, holdUntil,
    ...(saving ? { discountsUntil: P.discountLastDay(o.start) } : {}),
    // Bank transfer: offered up front to families outside the US, as a link otherwise.
    // (Not once the deposit is in: then they only choose a plan.)
    wire: !prepaid && TK.wireDetails(schema)
      ? { ...TK.wireDetails(schema), reference: wireReference(app), international: isInternational(app), requested: enrolment.wire ? { plan: enrolment.wire.plan, amount: enrolment.wire.amount, at: enrolment.wire.at } : null }
      : null,
    ...(prepaid ? { prepaid } : {}),
    // the plan they picked when they said they'd pay by bank transfer (preselected)
    ...(enrolment.wire?.plan ? { wirePlan: enrolment.wire.plan } : {}),
    balance: opts.balance, daysToStart: opts.daysToStart, options: opts.options, rates,
    terms: terms ? { version: terms.version, title: terms.title, url: `${siteUrl()}/terms?v=${terms.version}` } : null,
  };
}

const PLAN_LABEL = { monthly: "Monthly payments", two: "Two instalments", full: "Paid in full", later: "Deposit now, balance later" };

/** Start Stripe Checkout for the chosen option. Returns { url }. */
export async function startCheckout(app, { plan, method, agree, token }, schema, now = new Date()) {
  const { enrolment, decision } = await readEnrolment(app.id);
  const terms = await publishedTermsOrNull();
  const dealTotal = (await dealPaid(app, { fresh: true }))?.total ?? null;
  const view = offerView(app, { enrolment, decision, dealTotal }, schema, terms, now);
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
  const pendingBase = { plan, method, option, rate, charge, prepaid: view.prepaid || 0, termsVersion: terms?.version || null, agreedAt: now.toISOString(), at: now.toISOString() };
  if (charge.base <= 0) {
    // Deposit already paid, nothing due today.
    if (option.payments.some((p) => p.kind === "instalment")) {
      // Save a card / bank account for the automatic payments (Checkout, setup mode).
      const session = await createSetupCheckout({
        app, successUrl: `${ret}&paid=1&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${ret}&cancelled=1`,
        metadata: { payment_kind: "deposit", plan, method, terms_version: terms?.version || "" },
      });
      await patchEnrolment(app.id, { pending: { ...pendingBase, sessionId: session.id } });
      return { url: session.url };
    }
    // "Balance later": nothing to charge or save — record the choice now.
    const sessionId = `none-${now.getTime()}`;
    await patchEnrolment(app.id, { pending: { ...pendingBase, sessionId } });
    await recordDeposit({ id: sessionId, client_reference_id: app.id, payment_status: "paid", status: "complete", mode: "none" }, schema);
    return { url: `${ret}&paid=1` };
  }
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
  const status = session.payment_status === "paid" || (session.mode === "setup" && session.status === "complete") ? "paid"
    : session.status === "complete" && session.payment_status === "unpaid" ? "processing" : null;
  if (!status) return { first: false };
  if (enrolment.deposit?.sessionId === session.id && (enrolment.deposit.status === status || enrolment.deposit.status === "paid")) return { first: false, enrolment };

  let paymentMethod = null; let method = choice.method;
  try {
    if (session.mode !== "setup" && session.payment_intent) paymentMethod = (await getPaymentIntent(session.payment_intent))?.payment_method || null;
    else if (session.setup_intent) {
      const pm = (await getSetupIntent(typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id))?.payment_method;
      paymentMethod = pm || null;
      if (pm?.type) method = pm.type === "us_bank_account" ? "ach" : "card";
    }
  } catch { /* not needed to confirm the place */ }
  const prepaid = choice.prepaid ? { total: choice.prepaid, reference: enrolment.prepaid?.reference || "on the HubSpot deal", at: enrolment.prepaid?.at || null } : null;
  const paidAt = new Date().toISOString();
  const today = choice.option.payments[0];
  let schedule = choice.option.payments.map((p, i) => ({ ...p, status: i === 0 ? status : p.manual ? "due" : "scheduled" }));
  if (prepaid) {
    // The deposit row is what they paid another way; anything charged today is a first instalment.
    schedule = [
      { due: String(prepaid.at || paidAt).slice(0, 10), amount: Number(prepaid.total), kind: "deposit", status: "paid", reference: prepaid.reference || null, method: "manual", label: "Paid before choosing a plan" },
      ...(today.amount > 0 ? [{ ...today, kind: "instalment", status, ...(status === "paid" ? { paidAt, reference: session.payment_intent || session.id } : {}) }] : []),
      ...schedule.slice(1),
    ];
  }
  const deposit = prepaid
    ? { amount: Number(prepaid.total), fee: 0, total: Number(prepaid.total), method: "manual", reference: prepaid.reference || "paid outside Stripe", outside: true,
        sessionId: session.id, status, paidAt: prepaid.at || paidAt, ...(today.amount > 0 ? { todayAmount: choice.charge.total, todayReference: session.payment_intent || session.id } : {}),
        ...(choice.option?.discount ? { discount: choice.option.discount, discountPlan: choice.plan } : {}) }
    : {
        amount: choice.charge.base, fee: choice.charge.fee, total: choice.charge.total, method: choice.method,
        reference: session.payment_intent || session.id, sessionId: session.id, status, paidAt,
        ...(choice.option?.discount ? { discount: choice.option.discount, discountPlan: choice.plan } : {}),
      };
  const patch = {
    choice: { plan: choice.plan, method, rate: method === choice.method ? (choice.rate ?? null) : K.surchargeRates(schema)[method], termsVersion: choice.termsVersion, agreedAt: choice.agreedAt },
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
      // Paid another way: whoever recorded it logged it; only today's charge (if any) goes on the deal here.
      const logged = deposit.outside ? (deposit.todayReference ? { amount: choice.charge.base, reference: deposit.todayReference } : null) : { amount: deposit.amount, reference: deposit.reference };
      const slot = logged && R.choosePaymentSlot(deal?.properties || {}, logged.reference);
      if (slot) props[slot] = R.paymentEntry(logged.amount, logged.reference, paidAt);
      // Plan discount: the deal's amount becomes what they actually owe,
      // so the portal (and reporting) don't show the discount as still due.
      if (deposit.discount && enrolment.offer?.tuition) props.amount = String(Math.round((enrolment.offer.tuition - deposit.discount) * 100) / 100);
      if (Object.keys(props).length) await HS.updateDeal(app.hubspot_deal_id, props);
      const plan = PLAN_LABEL[choice.plan];
      const rows = schedule.filter((p) => p.kind !== "deposit").map((p) => `<li>${esc(p.due)} — $${p.amount.toFixed(2)}${p.manual ? " (to pay by this date)" : " (automatic)"}</li>`).join("");
      await HS.addNote(`<p><strong>${deposit.outside ? "Payment plan chosen" : "Place confirmed"}</strong> — ${deposit.outside ? `deposit of $${deposit.amount.toFixed(2)} paid outside Stripe (${esc(deposit.reference)})${deposit.todayAmount ? `; $${Number(deposit.todayAmount).toFixed(2)} paid today` : ""}${paymentMethod ? `; ${method === "ach" ? "bank account" : "card"} saved for automatic payments` : ""}` : `paid $${deposit.total.toFixed(2)} by ${choice.method === "ach" ? "bank account" : "card"} (${esc(deposit.reference)})`}. Plan: ${esc(plan)}${deposit.discount ? ` with the $${deposit.discount.toLocaleString("en-US")} ${choice.plan === "two" ? "two-instalment (off the final payment)" : "pay-in-full"} discount (deal amount set to $${(enrolment.offer.tuition - deposit.discount).toLocaleString("en-US")})` : ""}. Terms v${esc(choice.termsVersion || "?")} agreed ${esc(choice.agreedAt)}.</p>${rows ? `<ul>${rows}</ul>` : ""}`,
        { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id });
      patch.hubspot = { ok: true, stage: props.dealstage ? st.label : null };
    } catch (err) { log.error?.("[enrol hubspot]", err.message); patch.hubspot = { ok: false, error: String(err.message).slice(0, 300) }; }
  }
  if (mailOn() && TK.emailTemplate(schema, "enrolled").enabled) {
    try {
      const terms = await publishedTermsOrNull(choice.termsVersion ? { version: choice.termsVersion } : {});
      const msg = await sendEnrolled(app, schema, { enrolment: now, terms, payOff: payOffSaving(app, now, schema) });
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


/**
 * The family will pay by bank transfer: record the plan they chose and that
 * they agreed to the terms, email them the details, tell admissions. Admissions
 * marks the deposit paid when it arrives (dashboard → Mark deposit paid).
 */
export async function startWire(app, { plan, agree, token }, schema, now = new Date(), { log = console } = {}) {
  const { enrolment, decision } = await readEnrolment(app.id);
  const terms = await publishedTermsOrNull();
  const dealTotal = (await dealPaid(app, { fresh: true }))?.total ?? null;
  const view = offerView(app, { enrolment, decision, dealTotal }, schema, terms, now);
  if (view.state === "enrolled") throw bad("Your place is already confirmed.", 409);
  if (view.state === "expired") throw bad("The hold on your place has passed. Please contact admissions — they can extend it.", 409);
  if (view.state !== "offer" || !view.wire) throw bad("Bank transfer isn't available for this offer.", 409);
  if (!agree) throw bad("Please agree to the Program Terms & Conditions to continue.");
  const option = view.options.find((o) => o.key === plan);
  if (!option) throw bad("That payment option isn't available.");
  const amount = option.payments[0].amount;
  if (!(amount > 0)) throw bad("There's nothing to pay today.", 409);
  const prev = enrolment.wire;
  const wire = { plan, amount, reference: view.wire.reference, termsVersion: terms?.version || null, agreedAt: now.toISOString(), at: now.toISOString() };
  await patchEnrolment(app.id, { wire });
  // Asked again within a few minutes with the same choice (double click): no second email.
  if (prev && prev.plan === plan && prev.amount === amount && now - new Date(prev.at) < 10 * 60e3) return { ok: true, wire, repeat: true };
  const holdUntil = new Date(view.holdUntil).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: process.env.INTERVIEW_TZ || "America/Denver" });
  const usd = formatUsd;
  const planName = PLAN_LABEL[plan] || plan;
  let email = null;
  if (mailOn() && TK.emailTemplate(schema, "wireInstructions").enabled) {
    try {
      const msg = await sendFamily(app, schema, "wireInstructions", {
        amount: usd(amount), reference: view.wire.reference, holdUntil, link: acceptLink(token),
        details: view.wire.lines.map(([k, v]) => `- ${k ? `**${k}:** ` : ""}${v}`).join("\n"), wireNote: view.wire.note,
      });
      const scrub = (x) => String(x || "").split(acceptLink(token)).join(acceptLink(""));
      email = { to: msg.to, at: now.toISOString(), hubspot: await logFamilyEmail(app, { ...msg, text: scrub(msg.text), html: scrub(msg.html) }).catch(() => null) };
    } catch (err) { log.error?.("[wire email]", err.message); email = { error: String(err.message).slice(0, 300) }; }
  }
  await patchEnrolment(app.id, { wire: { ...wire, email } });
  if (hubspotOn() && (app.hubspot_contact_id || app.hubspot_deal_id)) {
    try { await HS.addNote(`<p><strong>Paying by bank transfer</strong> — ${esc(usd(amount))} for the ${esc(planName)} option; reference "${esc(view.wire.reference)}". Terms v${esc(terms?.version || "?")} agreed. Mark the deposit paid in the dashboard when it arrives.</p>`, { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id }); }
    catch (err) { log.error?.("[wire note]", err.message); }
  }
  if (alertOn()) {
    try {
      await sendAdmissionsAlert(app, "Paying by bank transfer", [
        `They chose to pay ${usd(amount)} by bank transfer (${planName}), reference "${view.wire.reference}". Their place is held until ${holdUntil}.`,
        "When the money arrives in Wise, open the application in the dashboard and use Mark deposit paid. They'll then be emailed to confirm their payment plan. If it's slow to arrive, use Extend hold.",
      ]);
    } catch (err) { log.error?.("[wire alert]", err.message); }
  }
  return { ok: true, wire: { ...wire, email } };
}
