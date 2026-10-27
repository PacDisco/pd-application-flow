// After the deposit (stage 4b): automatic instalments, payment notices,
// retries, the "balance later" reminders, paying from the acceptance page,
// changing the saved card / bank account, deposit reminders and withdrawals.
//
// Everything lives in applications.enrolment (MIGRATION-enrolment.sql):
//   schedule[i]  { due, amount, kind: deposit|instalment|balance, manual?, status, … }
//     status  scheduled         automatic, not yet due
//             charging          claimed by a run; Stripe call in flight
//             processing        bank (ACH) payment clearing
//             paid              { paidAt, reference, fee, total, method }
//             failed            { attempts, nextAttemptAt, lastError } — retried
//             needs_admissions  failed MAX_ATTEMPTS times — admissions told
//             due               manual (balance later): the family pays it
//             cancelled         withdrew after the deposit
//   paused        { at, by }    admissions paused automatic payments
//   withdrawn     { at, by, reason, kept }
//   depositReminded { "<holdUntil>|<stage>": at }   holdExpired { holdUntil, at }
//
// Run hourly by enrol-payments.mjs. Every send and every charge is claimed in
// the database first (atomic), so overlapping runs, the return page and the
// webhook never double-charge or double-email. A missed run never sends a
// burst of old notices.

import { db } from "./db.mjs";
import * as A from "./applications.mjs";
import * as HS from "./hubspot.mjs";
import * as R from "./routing.mjs";
import * as K from "../../../public/form-kit.mjs";
import * as P from "../../../public/plans-kit.mjs";
import * as TK from "../../../public/terms-kit.mjs";
import { chargeSaved, expireCheckout, createDepositCheckout, createSetupCheckout, getSetupIntent, getPaymentIntent, getCheckoutSession, customerFor } from "./stripe.mjs";
import { mailOn, alertOn, sendFamily, sendAdmissionsAlert, formatUsd as usd } from "./notify.mjs";
import { logFamilyEmail, hubspotOn } from "./email-log.mjs";
import { acceptLink, paidSoFar } from "./enrol.mjs";
import { dealPaid } from "./deal-paid.mjs";

const DAY = 864e5;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Email 3 days before an automatic payment. */
export const NOTICE_DAYS = 3;
/** Days to the next try after the 1st and 2nd failure; 3 tries, then admissions. */
export const RETRY_DAYS = [3, 4];
export const MAX_ATTEMPTS = 3;
/** "Balance later": reminders this many days before it's due. */
export const BALANCE_REMIND_DAYS = [14, 3];
/** Deposit reminders when this many days are left on the hold. */
export const DEPOSIT_REMIND_LEFT = [5, 2, 1];
/** Per run, so a mistake can't run away. */
export const MAX_ACTIONS_PER_RUN = 40;
const MIN_GAP_MS = 20 * 3600e3;

const OPEN = ["scheduled", "failed", "needs_admissions", "due"];
export const PAYABLE = ["failed", "needs_admissions", "due"];

export function paymentSettings(schema) {
  const p = schema?.settings?.payments || {};
  return { autoCharge: p.autoCharge !== false, depositReminders: p.depositReminders !== false, tz: process.env.INTERVIEW_TZ || "America/Denver" };
}

/** Calendar day (YYYY-MM-DD) in admissions' time zone. */
export function localDay(now = new Date(), tz = "America/Denver") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
const addDays = (iso, n) => P.iso(new Date(P.day(iso).getTime() + n * DAY));
const longDate = (d) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${d}T12:00:00Z` : d)
  .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? "UTC" : (process.env.INTERVIEW_TZ || "America/Denver") });
const methodName = (m) => (m === "ach" ? "bank account" : "card");

/** The processing-fee rate for a method: what they agreed to, else today's setting. */
export function rateFor(e, schema, method = e?.choice?.method) {
  if (method === (e?.choice?.method) && e?.choice?.rate != null) return Number(e.choice.rate);
  return K.surchargeRates(schema)[method === "ach" ? "ach" : "card"];
}

/**
 * What to do with schedule item `i` now. Pure (tested).
 *   { action: "charge" | "notice" | "remind", stage? | "overdue" | "none" }
 */
export function itemAction(item, e, now, cfg) {
  if (!item || e?.withdrawn) return { action: "none" };
  const today = localDay(now, cfg.tz);
  if (item.status === "scheduled" && !item.manual) {
    if (e.paused) return { action: "none", reason: "paused" };
    if (item.payingUntil && new Date(item.payingUntil) > now) return { action: "none", reason: "paying on the page" };
    if (today >= item.due) return cfg.autoCharge ? { action: "charge" } : { action: "none", reason: "automatic charging off" };
    if (!item.noticeAt && today >= addDays(item.due, -NOTICE_DAYS)) return { action: "notice" };
    return { action: "none" };
  }
  // A run that died mid-charge: ask Stripe again with the same idempotency key
  // (returns the original attempt's result, never a second charge).
  if (item.status === "charging" && item.chargingAt && now - new Date(item.chargingAt) > 30 * 60e3) return { action: "charge" };
  if (item.status === "failed") {
    if (e.paused) return { action: "none", reason: "paused" };
    if (item.payingUntil && new Date(item.payingUntil) > now) return { action: "none", reason: "paying on the page" };
    if (item.nextAttemptAt && new Date(item.nextAttemptAt) <= now) return cfg.autoCharge ? { action: "charge" } : { action: "none", reason: "automatic charging off" };
    return { action: "none" };
  }
  if (item.status === "due" && item.manual) {
    if (today > item.due) return item.overdueAt ? { action: "none" } : { action: "overdue" };
    const reminded = item.reminded || [];
    // The latest reminder whose day has come (earlier missed ones are skipped).
    const stage = [...BALANCE_REMIND_DAYS].sort((a, b) => a - b).find((d) => today >= addDays(item.due, -d));
    if (stage != null && !reminded.some((r) => r <= stage)) return { action: "remind", stage };
    return { action: "none" };
  }
  return { action: "none" };
}

/** Deposit not paid yet: reminder / hold passed. Pure (tested). */
export function depositAction(e, decision, now, cfg) {
  if (!cfg.depositReminders || decision?.outcome !== "accepted" || !e?.offer) return { action: "none" };
  if (["paid", "processing"].includes(e.deposit?.status)) return { action: "none" };
  if (e.prepaid) return { action: "none", reason: "deposit paid another way" };
  const holdUntil = decision.holdUntil || e.offer.holdUntil;
  if (!holdUntil) return { action: "none" };
  const hold = new Date(holdUntil);
  if (now >= hold) return e.holdExpired?.holdUntil === holdUntil ? { action: "none" } : { action: "expired", holdUntil };
  if (now - new Date(decision.at || 0) < DAY) return { action: "none", reason: "just accepted" };
  const left = (hold - now) / DAY;
  const stage = [...DEPOSIT_REMIND_LEFT].sort((a, b) => a - b).find((d) => left <= d);
  if (stage == null) return { action: "none" };
  const sent = Object.entries(e.depositReminded || {}).filter(([k]) => k.startsWith(`${holdUntil}|`));
  if (sent.some(([k]) => Number(k.split("|")[1]) <= stage)) return { action: "none" };
  const last = Math.max(0, ...Object.values(e.depositReminded || {}).map((t) => Date.parse(t) || 0));
  if (now - last < MIN_GAP_MS) return { action: "none", reason: "sent recently" };
  return { action: "remind", stage, holdUntil };
}

// ── atomic updates ─────────────────────────────────────────────────────────

/** Merge `patch` into schedule[idx] if its status is one of `from`. Returns the new enrolment or null. */
export async function updateItem(appId, idx, from, patch) {
  const rows = await db().query(
    `UPDATE applications
        SET enrolment = jsonb_set(enrolment, $2::text[], (enrolment->'schedule'->($3::int)) || $4::jsonb), updated_at = now()
      WHERE id = $1 AND enrolment->'schedule'->($3::int)->>'status' = ANY($5::text[])
      RETURNING enrolment`,
    [appId, `{schedule,${Number(idx)}}`, Number(idx), JSON.stringify(patch), from]);
  return rows[0]?.enrolment || null;
}

/** Set schedule[idx][field] only if it isn't set yet (claims a one-off send). */
async function claimItemField(appId, idx, field, value) {
  const rows = await db().query(
    `UPDATE applications
        SET enrolment = jsonb_set(enrolment, $2::text[], to_jsonb($4::text)), updated_at = now()
      WHERE id = $1 AND (enrolment->'schedule'->($3::int)) IS NOT NULL AND NOT ((enrolment->'schedule'->($3::int)) ? $5)
      RETURNING enrolment`,
    [appId, `{schedule,${Number(idx)},${field}}`, Number(idx), String(value), field]);
  return rows[0]?.enrolment || null;
}
async function unsetItemField(appId, idx, field) {
  await db().query(`UPDATE applications SET enrolment = enrolment #- $2::text[] WHERE id = $1`, [appId, `{schedule,${Number(idx)},${field}}`]);
}
/** enrolment[map][key] = value, only if the key isn't there yet. */
async function claimKey(appId, map, key, value) {
  const rows = await db().query(
    `UPDATE applications
        SET enrolment = jsonb_set(enrolment, $2::text[], COALESCE(enrolment->$3, '{}'::jsonb) || jsonb_build_object($4::text, $5::text)), updated_at = now()
      WHERE id = $1 AND NOT (COALESCE(enrolment->$3, '{}'::jsonb) ? $4)
      RETURNING enrolment`,
    [appId, `{${map}}`, map, key, String(value)]);
  return rows[0]?.enrolment || null;
}
async function patchEnrolment(id, patch) {
  const rows = await db().query(
    `UPDATE applications SET enrolment = COALESCE(enrolment, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING enrolment`,
    [id, JSON.stringify(patch)]);
  return rows[0]?.enrolment || null;
}
async function readEnrolment(id) {
  const rows = await db().query(`SELECT enrolment, decision FROM applications WHERE id = $1`, [id]);
  return { enrolment: rows[0]?.enrolment || {}, decision: rows[0]?.decision || null };
}

// ── emails + HubSpot ───────────────────────────────────────────────────────

/** Remaining balance and the next payment, for the emails. */
export function balanceLine(schedule) {
  const open = (schedule || []).filter((p) => OPEN.includes(p.status) || p.status === "charging" || p.status === "processing");
  if (!open.length) return "Your tuition is now paid in full — thank you!";
  const left = open.reduce((a, p) => a + Math.round(p.amount * 100), 0) / 100;
  const next = [...open].sort((a, b) => a.due.localeCompare(b.due))[0];
  return `Remaining tuition: ${usd(left)}. Next payment: ${usd(next.amount)} ${next.manual ? "due by" : "on"} ${longDate(next.due)}.`;
}

/** Send a family email with a fresh personal link, logged in HubSpot with the link removed. */
async function familyEmail(app, schema, key, vars, { log = console } = {}) {
  if (!mailOn() || !TK.emailTemplate(schema, key).enabled) return { skipped: true };
  const token = await A.addLinkToken(app.id);
  const link = acceptLink(token);
  const msg = await sendFamily(app, schema, key, { ...vars, link });
  const scrub = (x) => String(x || "").split(link).join(acceptLink("")).split(link.replace(/&/g, "&amp;")).join(acceptLink(""));
  let hubspot = null;
  try { hubspot = await logFamilyEmail(app, { ...msg, text: scrub(msg.text), html: scrub(msg.html) }); }
  catch (err) { log.error?.("[payments log]", err.message); }
  return { to: msg.to, at: new Date().toISOString(), hubspot };
}

async function note(app, html, log = console) {
  if (!hubspotOn() || !(app.hubspot_contact_id || app.hubspot_deal_id)) return;
  try { await HS.addNote(html, { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id }); }
  catch (err) { log.error?.("[payments note]", err.message); }
}

async function hubspotPayment(app, amount, reference, paidAt, log = console) {
  if (!hubspotOn() || !app.hubspot_deal_id) return null;
  try {
    const deal = await HS.getDeal(app.hubspot_deal_id);
    const slot = R.choosePaymentSlot(deal?.properties || {}, reference);
    if (slot) await HS.updateDeal(app.hubspot_deal_id, { [slot]: R.paymentEntry(amount, reference, paidAt) });
    return slot;
  } catch (err) { log.error?.("[payments hubspot]", err.message); return null; }
}

const REASONS = {
  insufficient_funds: "insufficient funds", card_declined: "the card was declined", generic_decline: "the card was declined",
  expired_card: "the card has expired", authentication_required: "your bank needs you to approve the payment",
  do_not_honor: "the card was declined", lost_card: "the card was reported lost", stolen_card: "the card was reported stolen",
  incorrect_number: "the card number is no longer valid", account_closed: "the bank account is closed", no_account: "the bank account couldn't be found",
  debit_not_authorized: "the bank didn't authorise the debit", no_payment_method: "there's no saved card or bank account",
};
export const reasonText = (code) => REASONS[code] || "your bank declined it";

// ── outcomes ───────────────────────────────────────────────────────────────

/** Mark an item paid (once) → HubSpot payment_N + note, receipt email. */
export async function itemPaid(appId, idx, info, schema, { from, log = console, quiet = false } = {}) {
  const paidAt = new Date().toISOString();
  const e = await updateItem(appId, idx, from, {
    status: "paid", paidAt, reference: info.reference, fee: info.fee ?? 0, total: info.total ?? info.amount, method: info.method,
    lastError: null, nextAttemptAt: null, payingUntil: null, ...(info.by ? { markedBy: info.by } : {}),
  });
  if (!e) return false;
  if (quiet) return e;
  const app = await A.byId(appId);
  const item = e.schedule[idx];
  await hubspotPayment(app, item.amount, info.reference, paidAt, log);
  const n = e.schedule.filter((p) => p.kind !== "deposit").indexOf(item) + 1;
  const all = e.schedule.filter((p) => p.kind !== "deposit").length;
  const done = !e.schedule.some((p) => OPEN.includes(p.status) || p.status === "processing" || p.status === "charging");
  await note(app, `<p><strong>Tuition payment received</strong> — ${usd(info.total ?? item.amount)} (${n} of ${all}) by ${methodName(info.method)} (${esc(info.reference)}).${done ? " <strong>Tuition paid in full.</strong>" : ""}</p>`, log);
  try {
    const email = await familyEmail(app, schema, "paymentReceived", { amount: usd(info.total ?? item.amount), balanceLine: balanceLine(e.schedule) }, { log });
    if (!email.skipped) await updateItem(appId, idx, ["paid"], { email });
  } catch (err) { log.error?.("[payments receipt]", err.message); await updateItem(appId, idx, ["paid"], { email: { error: String(err.message).slice(0, 300) } }); }
  return true;
}

/** An automatic attempt failed → retry later, or (after MAX_ATTEMPTS) admissions. */
export async function itemFailed(appId, idx, info, schema, { from, attempt, now = new Date(), log = console } = {}) {
  const final = attempt >= MAX_ATTEMPTS;
  const nextAttemptAt = final ? null : new Date(now.getTime() + (RETRY_DAYS[attempt - 1] ?? 4) * DAY).toISOString();
  const lastError = { reason: info.reason || "declined", message: String(info.message || "").slice(0, 300), at: now.toISOString(), paymentIntent: info.paymentIntent || null };
  const e = await updateItem(appId, idx, from, { status: final ? "needs_admissions" : "failed", attempts: attempt, nextAttemptAt, lastError });
  if (!e) return false;
  const app = await A.byId(appId);
  const item = e.schedule[idx];
  const amount = usd(item.amount + P.surcharge(item.amount, rateFor(e, schema)));
  await note(app, `<p><strong>Automatic tuition payment failed</strong> (try ${attempt} of ${MAX_ATTEMPTS}) — ${amount} due ${esc(item.due)}: ${esc(reasonText(lastError.reason))}${lastError.message ? ` — ${esc(lastError.message)}` : ""}. ${final ? "No more automatic tries; admissions alerted." : `Next try ${esc(longDate(nextAttemptAt))}.`}</p>`, log);
  try {
    const nextStep = final
      ? "We won't try this payment again automatically — our admissions team will be in touch to help sort it out. You can also pay now, or switch to a different card or bank account, with the button below."
      : `We'll try again on ${longDate(nextAttemptAt)}. If you'd like to pay now, or use a different card or bank account, use the button below.`;
    const email = await familyEmail(app, schema, "paymentFailed", { amount, date: longDate(item.due), reason: reasonText(lastError.reason), nextStep }, { log });
    if (!email.skipped) await updateItem(appId, idx, ["failed", "needs_admissions"], { failEmail: email });
  } catch (err) { log.error?.("[payments failed email]", err.message); }
  if (final && alertOn()) {
    try {
      await sendAdmissionsAlert(app, "Tuition payment failed", [
        `The automatic payment of ${amount} due ${longDate(item.due)} failed ${MAX_ATTEMPTS} times (${reasonText(lastError.reason)}). It won't be tried again automatically.`,
        "Please contact the family. They can pay or change their card / bank account from their acceptance link (sent with the failure email). Under the terms, money already paid is handled under the refund terms if this isn't resolved.",
        "In the dashboard you can retry the payment once they've sorted it out.",
      ]);
    } catch (err) { log.error?.("[payments alert]", err.message); }
  }
  return true;
}

// ── the hourly run ─────────────────────────────────────────────────────────

/** Charge item `idx` of an application now (claimed first). */
export async function chargeItem(app, e, idx, schema, { now = new Date(), log = console } = {}) {
  const item = e.schedule[idx];
  const method = e.choice?.method === "ach" ? "ach" : "card";
  const rate = rateFor(e, schema);
  const attempt = (Number(item.attempts) || 0) + 1;
  const from = [item.status];
  const claimed = await updateItem(app.id, idx, from, { status: "charging", chargingAt: now.toISOString() });
  if (!claimed) return { skipped: "taken" };
  if (!e.stripe?.customer || !e.stripe?.paymentMethod) {
    await itemFailed(app.id, idx, { reason: "no_payment_method" }, schema, { from: ["charging"], attempt: MAX_ATTEMPTS, now, log });
    return { failed: "no payment method" };
  }
  const fee = P.surcharge(item.amount, rate);
  const total = Math.round((item.amount + fee) * 100) / 100;
  let pi;
  try {
    pi = await chargeSaved({
      customer: e.stripe.customer, paymentMethod: e.stripe.paymentMethod, amount: total,
      currency: String(schema?.settings?.currency || "usd").toLowerCase(), method,
      description: `Tuition ${item.kind === "balance" ? "balance" : "instalment"} — ${app.program || "Pacific Discovery"} — ${app.first_name || ""} ${app.last_name || ""}`.trim(),
      metadata: {
        source: "pd-apply", payment_kind: "instalment", application_id: app.id, item: idx, attempt,
        base_amount: item.amount, processing_fee: fee, method, program: String(app.program || "").slice(0, 200),
        ...(app.hubspot_deal_id ? { deal_id: app.hubspot_deal_id } : {}),
      },
      idempotencyKey: `pd-inst-${app.id}-${idx}-${attempt}`,
    });
  } catch (err) {
    // Couldn't reach Stripe / config problem: put it back, try next run.
    await updateItem(app.id, idx, ["charging"], { status: item.status, lastError: { reason: "stripe_unreachable", message: String(err.message).slice(0, 300), at: now.toISOString() } });
    log.error?.("[payments charge]", err.message);
    return { error: err.message };
  }
  const info = { reference: pi.id, amount: item.amount, fee, total, method };
  if (pi.status === "succeeded") { await itemPaid(app.id, idx, info, schema, { from: ["charging"], log }); return { paid: pi.id }; }
  if (pi.status === "processing") { await updateItem(app.id, idx, ["charging"], { status: "processing", paymentIntent: pi.id, attempts: attempt, fee, total, method }); return { processing: pi.id }; }
  const code = pi.error || pi.last_payment_error?.decline_code || pi.last_payment_error?.code || (pi.status === "requires_action" ? "authentication_required" : "declined");
  await itemFailed(app.id, idx, { reason: code, message: pi.message || pi.last_payment_error?.message, paymentIntent: pi.id }, schema, { from: ["charging"], attempt, now, log });
  return { failed: code };
}

async function sendNotice(app, e, idx, schema, now, log) {
  const item = e.schedule[idx];
  if (!(await claimItemField(app.id, idx, "noticeAt", now.toISOString()))) return { skipped: "taken" };
  try {
    const rate = rateFor(e, schema);
    const amount = usd(item.amount + P.surcharge(item.amount, rate));
    const email = await familyEmail(app, schema, "paymentUpcoming", {
      amount, method: methodName(e.choice?.method), date: longDate(item.due), balanceLine: balanceLine(e.schedule),
    }, { log });
    if (!email.skipped) await updateItem(app.id, idx, [item.status], { noticeEmail: email });
    return { notice: idx };
  } catch (err) {
    await unsetItemField(app.id, idx, "noticeAt");
    log.error?.("[payments notice]", err.message);
    return { error: err.message };
  }
}

async function balanceReminder(app, e, idx, stage, schema, now, log) {
  const item = e.schedule[idx];
  const reminded = [...new Set([...(item.reminded || []), ...BALANCE_REMIND_DAYS.filter((d) => d >= stage)])];
  if (!(await updateItem(app.id, idx, ["due"], { reminded, remindedAt: now.toISOString() }))) return { skipped: "taken" };
  try {
    const email = await familyEmail(app, schema, "balanceReminder", { amount: usd(item.amount), date: longDate(item.due) }, { log });
    if (!email.skipped) await updateItem(app.id, idx, ["due"], { reminderEmail: email });
    return { reminded: stage };
  } catch (err) {
    await updateItem(app.id, idx, ["due"], { reminded: item.reminded || [] });
    log.error?.("[payments balance reminder]", err.message);
    return { error: err.message };
  }
}

async function balanceOverdue(app, e, idx, schema, now, log) {
  const item = e.schedule[idx];
  if (!(await claimItemField(app.id, idx, "overdueAt", now.toISOString()))) return { skipped: "taken" };
  await note(app, `<p><strong>Tuition balance overdue</strong> — ${usd(item.amount)} was due ${esc(item.due)}.</p>`, log);
  if (alertOn()) {
    try { await sendAdmissionsAlert(app, "Tuition balance overdue", [`The remaining tuition of ${usd(item.amount)} was due ${longDate(item.due)} and hasn't been paid. They can pay from their acceptance link; please contact the family.`]); }
    catch (err) { log.error?.("[payments overdue alert]", err.message); }
  }
  return { overdue: idx };
}

async function depositReminder(app, e, decision, act, schema, now, log) {
  const key = `${act.holdUntil}|${act.stage}`;
  if (!(await claimKey(app.id, "depositReminded", key, now.toISOString()))) return { skipped: "taken" };
  try {
    const hold = new Date(act.holdUntil).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: process.env.INTERVIEW_TZ || "America/Denver" });
    await familyEmail(app, schema, "depositReminder", { holdUntil: hold, deposit: usd(P.depositFor(app.paid_at ? Number(app.payment?.base ?? 250) : 0)) }, { log });
    return { depositReminder: act.stage };
  } catch (err) {
    await db().query(`UPDATE applications SET enrolment = enrolment #- $2::text[] WHERE id = $1`, [app.id, `{depositReminded,${key}}`]);
    log.error?.("[payments deposit reminder]", err.message);
    return { error: err.message };
  }
}

async function holdExpired(app, e, act, now, log) {
  const rows = await db().query(
    `UPDATE applications SET enrolment = enrolment || jsonb_build_object('holdExpired', jsonb_build_object('holdUntil', $2::text, 'at', $3::text)), updated_at = now()
      WHERE id = $1 AND COALESCE(enrolment->'holdExpired'->>'holdUntil', '') <> $2 RETURNING id`, [app.id, act.holdUntil, now.toISOString()]);
  if (!rows.length) return { skipped: "taken" };
  await note(app, `<p><strong>Hold passed</strong> — no deposit by ${esc(new Date(act.holdUntil).toLocaleString("en-US", { timeZone: process.env.INTERVIEW_TZ || "America/Denver" }))}. Extend the hold in the dashboard if they still want the place.</p>`, log);
  if (alertOn()) {
    try { await sendAdmissionsAlert(app, "Deposit not paid — hold passed", ["This applicant was accepted but hasn't paid the deposit, and the hold on their place has passed.", "If they still want the place, use Extend hold in the dashboard — their acceptance link then works again."]); }
    catch (err) { log.error?.("[payments hold alert]", err.message); }
  }
  return { holdExpired: true };
}

/** One pass over every accepted / enrolled application. */
export async function runPayments({ schema, now = new Date(), log = console } = {}) {
  const cfg = paymentSettings(schema);
  const rows = await db().query(
    `SELECT ${A.COLS}, enrolment, decision FROM applications
      WHERE status <> 'withdrawn' AND (decision->>'outcome') = 'accepted'
      ORDER BY updated_at`);
  const out = { checked: rows.length, actions: [] };
  for (const app of rows) {
    if (out.actions.length >= MAX_ACTIONS_PER_RUN) { out.capped = true; break; }
    const e = app.enrolment || {};
    try {
      if (e.withdrawn) continue;
      if (!["paid", "processing"].includes(e.deposit?.status)) {
        // Deposit paid another way and on the HubSpot deal → ask them to choose a plan (once).
        if (!e.prepaid) {
          const total = paidSoFar(app, e, (await dealPaid(app, { fresh: true }))?.total);
          if (total >= P.DEPOSIT_TOTAL) {
            out.actions.push({ id: app.id, ...(await recordPrepaid(app, { total, source: "hubspot", by: "the HubSpot deal" }, schema, { log })) });
            continue;
          }
        }
        const act = depositAction(e, app.decision, now, cfg);
        if (act.action === "remind") out.actions.push({ id: app.id, ...(await depositReminder(app, e, app.decision, act, schema, now, log)) });
        if (act.action === "expired") out.actions.push({ id: app.id, ...(await holdExpired(app, e, act, now, log)) });
        continue;
      }
      if (e.deposit?.status !== "paid") continue;
      // One thing per application per run, in schedule order.
      for (let i = 0; i < (e.schedule || []).length; i++) {
        const act = itemAction(e.schedule[i], e, now, cfg);
        if (act.action === "none") continue;
        let r;
        if (act.action === "charge") r = await chargeItem(app, e, i, schema, { now, log });
        else if (act.action === "notice") r = await sendNotice(app, e, i, schema, now, log);
        else if (act.action === "remind") r = await balanceReminder(app, e, i, act.stage, schema, now, log);
        else if (act.action === "overdue") r = await balanceOverdue(app, e, i, schema, now, log);
        out.actions.push({ id: app.id, item: i, action: act.action, ...r });
        break;
      }
    } catch (err) {
      log.error?.("[payments run]", app.id, err.message);
      out.actions.push({ id: app.id, error: err.message });
    }
  }
  return out;
}

// ── webhook: automatic payments that settle later (bank) ───────────────────

export async function paymentIntentEvent(type, pi, schema, { log = console } = {}) {
  const m = pi.metadata || {};
  if (m.payment_kind !== "instalment" || !m.application_id) return { ignored: true };
  const idx = Number(m.item);
  if (type === "payment_intent.succeeded") {
    const { enrolment } = await readEnrolment(m.application_id);
    const item = enrolment.schedule?.[idx];
    const fee = Number(m.processing_fee) || 0;
    return { paid: await itemPaid(m.application_id, idx, { reference: pi.id, amount: Number(m.base_amount) || item?.amount, fee, total: (pi.amount_received || pi.amount) / 100, method: m.method }, schema, { from: ["charging", "processing"], log }) };
  }
  if (type === "payment_intent.payment_failed") {
    const err = pi.last_payment_error || {};
    return { failed: await itemFailed(m.application_id, idx, { reason: err.decline_code || err.code || "declined", message: err.message, paymentIntent: pi.id }, schema, { from: ["charging", "processing"], attempt: Number(m.attempt) || 1, log }) };
  }
  return { ignored: true };
}

// ── from the acceptance page ───────────────────────────────────────────────

/** Close any unfinished checkout for these items; refuse if one was completed. */
async function closeOpenCheckouts(items, now) {
  const ids = [...new Set(items.filter((p) => p.checkoutSession && p.payingUntil && new Date(p.payingUntil) > now).map((p) => p.checkoutSession))];
  for (const id of ids) {
    if (!(await expireCheckout(id))) throw bad("A payment for this is already going through. Please check back in a few minutes.", 409);
  }
}

/** Pay one open item now (balance, or a failed instalment). Returns { url }. */
export async function startItemCheckout(app, { index, method, token }, schema, now = new Date()) {
  const { enrolment: e } = await readEnrolment(app.id);
  if (e.withdrawn) throw bad("This place has been cancelled. Please contact admissions.", 409);
  if (index === "rest") return startRestCheckout(app, e, { method, token }, schema, now);
  const idx = Number(index);
  const item = e.schedule?.[idx];
  if (!item || !PAYABLE.includes(item.status)) throw bad("That payment isn't open to pay now.", 409);
  if (!["card", "ach"].includes(method)) throw bad("Choose card or bank account.");
  await closeOpenCheckouts(openRest(e), now);
  const rate = rateFor(e, schema, method);
  const fee = P.surcharge(item.amount, rate);
  const program = app.program || "Pacific Discovery";
  const ret = acceptLink(token);
  const payingUntil = new Date(now.getTime() + 3600e3).toISOString();
  // Hold off the automatic retry while they're at Stripe.
  if (!(await updateItem(app.id, idx, PAYABLE, { payingUntil }))) throw bad("That payment isn't open to pay now.", 409);
  const what = item.kind === "balance" ? `Tuition balance — ${program}` : `Tuition instalment (${item.due}) — ${program}`;
  const session = await createDepositCheckout({
    app, currency: String(schema?.settings?.currency || "usd").toLowerCase(), method,
    lines: [[what, item.amount], [`${method === "ach" ? "Bank payment" : "Card processing"} fee (${(rate * 100).toFixed(1).replace(/\.0$/, "")}%)`, fee]],
    save: false,
    successUrl: `${ret}&paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ret}&cancelled=1`,
    description: `${what} — ${app.first_name || ""} ${app.last_name || ""}`.trim(),
    metadata: { payment_kind: "item", item: idx, method, base_amount: item.amount, processing_fee: fee, ...(app.hubspot_deal_id ? { deal_id: app.hubspot_deal_id } : {}) },
    expiresAt: Math.floor(now.getTime() / 1000) + 3600,
  });
  await updateItem(app.id, idx, PAYABLE, { checkoutSession: session.id });
  return { url: session.url };
}

/** Pay off everything left in one go (cancels the automatic payments it covers). */
async function startRestCheckout(app, e, { method, token }, schema, now) {
  if (!["paid"].includes(e.deposit?.status)) throw bad("Your deposit hasn't cleared yet.", 409);
  if (!["card", "ach"].includes(method)) throw bad("Choose card or bank account.");
  const items = openRest(e);
  if (!items.length) throw bad("There's nothing left to pay.", 409);
  await closeOpenCheckouts(items, now);
  const amount = Math.round(items.reduce((a, p) => a + p.amount * 100, 0)) / 100;
  const rate = rateFor(e, schema, method);
  const fee = P.surcharge(amount, rate);
  const payingUntil = new Date(now.getTime() + 3600e3).toISOString();
  for (const p of items) {
    if (!(await updateItem(app.id, p.i, ["scheduled", "failed", "needs_admissions", "due"], { payingUntil }))) throw bad("A payment is in progress — please try again in a few minutes.", 409);
  }
  const program = app.program || "Pacific Discovery";
  const ret = acceptLink(token);
  const session = await createDepositCheckout({
    app, currency: String(schema?.settings?.currency || "usd").toLowerCase(), method,
    lines: [[`Remaining tuition — ${program}`, amount], [`${method === "ach" ? "Bank payment" : "Card processing"} fee (${(rate * 100).toFixed(1).replace(/\.0$/, "")}%)`, fee]],
    save: false,
    successUrl: `${ret}&paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ret}&cancelled=1`,
    description: `Remaining tuition — ${program} — ${app.first_name || ""} ${app.last_name || ""}`.trim(),
    metadata: { payment_kind: "item", items: items.map((p) => p.i).join(","), method, base_amount: amount, processing_fee: fee, ...(app.hubspot_deal_id ? { deal_id: app.hubspot_deal_id } : {}) },
    expiresAt: Math.floor(now.getTime() / 1000) + 3600,
  });
  for (const p of items) await updateItem(app.id, p.i, ["scheduled", "failed", "needs_admissions", "due"], { checkoutSession: session.id });
  return { url: session.url };
}
const openRest = (e) => (e.schedule || []).map((p, idx) => ({ ...p, i: idx })).filter((p) => p.i > 0 && ["scheduled", "failed", "needs_admissions", "due"].includes(p.status));

/** Several items paid by one checkout: each marked paid, one HubSpot entry, one receipt. */
async function recordRest(session, schema, idxs, status, log) {
  const m = session.metadata || {};
  const appId = session.client_reference_id;
  const { enrolment: e } = await readEnrolment(appId);
  const mine = idxs.filter((i) => e.schedule?.[i]?.checkoutSession === session.id);
  if (!mine.length) return { ignored: true };
  const OPENISH = ["scheduled", "failed", "needs_admissions", "due"];
  if (status === "processing") {
    for (const i of mine) await updateItem(appId, i, OPENISH, { status: "processing", paymentIntent: session.payment_intent, method: m.method });
    return { processing: true };
  }
  const reference = session.payment_intent || session.id;
  const total = (session.amount_total || 0) / 100;
  let last = null;
  for (const i of mine) {
    const r = await itemPaid(appId, i, { reference, amount: e.schedule[i].amount, fee: 0, total: e.schedule[i].amount, method: m.method }, schema, { from: [...OPENISH, "processing"], log, quiet: true });
    if (r) last = r;
  }
  if (!last) return { ignored: true };
  const app = await A.byId(appId);
  await hubspotPayment(app, Number(m.base_amount), reference, new Date().toISOString(), log);
  await note(app, `<p><strong>Remaining tuition paid in full</strong> — ${usd(total)} by ${methodName(m.method)} (${esc(reference)}), covering ${mine.length} payment${mine.length === 1 ? "" : "s"}.</p>`, log);
  try { await familyEmail(app, schema, "paymentReceived", { amount: usd(total), balanceLine: balanceLine(last.schedule) }, { log }); }
  catch (err) { log.error?.("[payments rest receipt]", err.message); }
  return { paid: mine.length };
}

/** A pay-now checkout finished (return page or webhook). */
export async function recordItemCheckout(session, schema, { log = console } = {}) {
  const m = session.metadata || {};
  const appId = session.client_reference_id;
  if (m.items) {
    const idxs = String(m.items).split(",").map(Number).filter(Number.isInteger);
    if (session.payment_status === "paid") return recordRest(session, schema, idxs, "paid", log);
    if (session.status === "complete") return recordRest(session, schema, idxs, "processing", log);
    return { ignored: true };
  }
  const idx = Number(m.item);
  const { enrolment: e } = await readEnrolment(appId);
  const item = e.schedule?.[idx];
  if (!item || item.checkoutSession !== session.id) return { ignored: true };
  const info = { reference: session.payment_intent || session.id, amount: Number(m.base_amount), fee: Number(m.processing_fee) || 0, total: (session.amount_total || 0) / 100, method: m.method };
  if (session.payment_status === "paid") return { paid: await itemPaid(appId, idx, info, schema, { from: [...PAYABLE, "processing"], log }) };
  if (session.status === "complete") { await updateItem(appId, idx, PAYABLE, { status: "processing", paymentIntent: session.payment_intent, method: m.method, fee: info.fee, total: info.total }); return { processing: true }; }
  return { ignored: true };
}

/** A bank pay-now payment bounced: open again. */
export async function itemCheckoutFailed(session, schema, { log = console } = {}) {
  const appId = session.client_reference_id;
  if (session.metadata?.items) {
    const { enrolment: e } = await readEnrolment(appId);
    let n = 0;
    for (const i of String(session.metadata.items).split(",").map(Number)) {
      const p = e.schedule?.[i];
      if (p?.checkoutSession !== session.id) continue;
      // back to how it was: automatic ones are tried again on the next run
      if (await updateItem(appId, i, ["processing"], { status: p.manual ? "due" : "failed", nextAttemptAt: new Date().toISOString(), payingUntil: null, lastError: { reason: "bank_payment_failed", at: new Date().toISOString() } })) n++;
    }
    if (n) await note(await A.byId(appId), "<p><strong>Bank payment failed</strong> for the remaining tuition. Automatic payments carry on as scheduled.</p>", log);
    return { failed: n };
  }
  const idx = Number(session.metadata?.item);
  const { enrolment: e } = await readEnrolment(appId);
  const item = e.schedule?.[idx];
  if (!item || item.checkoutSession !== session.id) return { ignored: true };
  const back = item.manual ? "due" : "needs_admissions";
  if (!(await updateItem(appId, idx, ["processing"], { status: back, payingUntil: null, lastError: { reason: "bank_payment_failed", at: new Date().toISOString() } }))) return { ignored: true };
  const app = await A.byId(appId);
  await note(app, `<p><strong>Bank payment failed</strong> for ${usd(item.amount)} (due ${esc(item.due)}). They can pay again from their acceptance link.</p>`, log);
  return { failed: true };
}

/** Change the saved card / bank account. Returns { url }. */
export async function startSetup(app, { token }) {
  const { enrolment: e } = await readEnrolment(app.id);
  if (e.withdrawn) throw bad("This place has been cancelled. Please contact admissions.", 409);
  if (!["paid", "processing"].includes(e.deposit?.status)) throw bad("There's no payment plan on this application yet.", 409);
  const ret = acceptLink(token);
  const session = await createSetupCheckout({
    app, customer: e.stripe?.customer || await customerFor(app.email, [app.first_name, app.last_name].filter(Boolean).join(" ")),
    successUrl: `${ret}&updated=1&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${ret}&cancelled=1`,
    metadata: { payment_kind: "setup" },
  });
  await patchEnrolment(app.id, { setupSession: session.id });
  return { url: session.url };
}

/** The new card / bank account is saved: use it, and retry anything that failed. */
export async function recordSetup(session, schema, { log = console } = {}) {
  const appId = session.client_reference_id;
  const { enrolment: e } = await readEnrolment(appId);
  if (e.setupSession !== session.id || e.stripe?.setupSession === session.id) return { ignored: true };
  if (session.status !== "complete" || !session.setup_intent) return { ignored: true };
  const si = await getSetupIntent(typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id);
  const pm = si?.payment_method;
  const pmId = typeof pm === "string" ? pm : pm?.id;
  if (!pmId) return { ignored: true };
  const type = typeof pm === "object" ? pm.type : null;
  const method = type === "us_bank_account" ? "ach" : "card";
  const rate = K.surchargeRates(schema)[method];
  const now = new Date().toISOString();
  await patchEnrolment(appId, {
    stripe: { ...(e.stripe || {}), customer: session.customer || e.stripe?.customer, paymentMethod: pmId, setupSession: session.id, updatedAt: now },
    choice: { ...(e.choice || {}), method, rate },
  });
  // Anything that failed is tried again on the next run with the new method.
  let retried = 0;
  for (let i = 0; i < (e.schedule || []).length; i++) {
    if (["failed", "needs_admissions"].includes(e.schedule[i].status) && !e.schedule[i].manual) {
      if (await updateItem(appId, i, ["failed", "needs_admissions"], { status: "failed", nextAttemptAt: now })) retried++;
    }
  }
  const app = await A.byId(appId);
  await note(app, `<p><strong>Payment method updated</strong> — automatic payments now use their ${methodName(method)}.${retried ? ` ${retried} failed payment${retried === 1 ? "" : "s"} will be retried within the hour.` : ""}</p>`, log);
  return { updated: true, retried };
}

/** The return page: confirm a pay-now or update-method session. */
export async function confirmReturn(app, sessionId, schema) {
  if (!sessionId) return;
  const { enrolment: e } = await readEnrolment(app.id);
  const known = e.setupSession === sessionId || (e.schedule || []).some((p) => p.checkoutSession === sessionId);
  if (!known) return;
  const s = await getCheckoutSession(sessionId);
  if (s?.client_reference_id !== app.id) return;
  if (s.metadata?.payment_kind === "setup") await recordSetup(s, schema);
  else if (s.metadata?.payment_kind === "item") await recordItemCheckout(s, schema);
}

// ── admissions ─────────────────────────────────────────────────────────────

/**
 * Withdrew after paying the deposit: future payments cancelled, what's been
 * paid is kept (per the terms), deal → Cancelled.
 */
export async function withdraw(appId, { by = "admissions", reason = "" } = {}, { log = console } = {}) {
  const app = await A.byId(appId);
  if (!app) throw bad("Application not found.", 404);
  const { enrolment: e } = await readEnrolment(appId);
  if (e.withdrawn) throw bad("Already withdrawn.", 409);
  const at = new Date().toISOString();
  let cancelled = 0; let cancelledAmount = 0;
  for (let i = 0; i < (e.schedule || []).length; i++) {
    const p = e.schedule[i];
    if (OPEN.includes(p.status) && (await updateItem(appId, i, OPEN, { status: "cancelled", cancelledAt: at }))) { cancelled++; cancelledAmount += p.amount; }
  }
  const kept = Math.round(((app.payment?.base ?? 0) + (e.schedule || []).filter((p) => p.status === "paid").reduce((a, p) => a + p.amount, 0)) * 100) / 100;
  const inFlight = (e.schedule || []).filter((p) => ["charging", "processing"].includes(p.status)).length;
  await patchEnrolment(appId, { withdrawn: { at, by: String(by).slice(0, 120), reason: String(reason || "").slice(0, 500), kept } });
  await db().query(`UPDATE applications SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [appId]);
  let stage = null;
  if (hubspotOn() && app.hubspot_deal_id) {
    try {
      const deal = await HS.getDeal(app.hubspot_deal_id);
      const pipe = (await HS.dealPipelines()).find((p) => p.id === String(deal?.properties?.pipeline));
      const st = R.findStage(pipe, "cancelled");
      if (st && R.isForward(pipe, deal?.properties?.dealstage, st)) { await HS.updateDeal(app.hubspot_deal_id, { dealstage: st.id }); stage = st.label; }
    } catch (err) { log.error?.("[withdraw hubspot]", err.message); }
  }
  await note(app, `<p><strong>Withdrew</strong> (recorded by ${esc(by)}).${reason ? ` Reason: ${esc(reason)}.` : ""} Kept per the terms: ${usd(kept)} paid to date. Cancelled ${cancelled} upcoming payment${cancelled === 1 ? "" : "s"} (${usd(cancelledAmount)}).${inFlight ? ` ${inFlight} payment${inFlight === 1 ? " is" : "s are"} still clearing — check Stripe.` : ""}</p>`, log);
  return { withdrawn: true, kept, cancelled, cancelledAmount, inFlight, stage };
}

/**
 * Admissions: the deposit was paid another way (bank transfer, the old portal
 * button). Holds the place, moves the deal to Deposit Paid, and emails the
 * family a link to choose how to pay the rest (no deposit charged again).
 */
export async function markDepositPaid(appId, { amount, reference = "", by = "admissions" } = {}, schema, { log = console } = {}) {
  const app = await A.byId(appId);
  if (!app) throw bad("Application not found.", 404);
  const { enrolment: e, decision: d } = await readEnrolment(appId);
  if (d?.outcome !== "accepted" || !e.offer) throw bad("Accept the application first (that sets the offer the plan is built from).", 409);
  if (["paid", "processing"].includes(e.deposit?.status) || e.prepaid) throw bad("The deposit is already recorded.", 409);
  const fee = paidSoFar(app, e, (await dealPaid(app, { fresh: true }))?.total);
  const amt = Math.round((Number(amount) || P.depositFor(fee)) * 100) / 100;
  if (amt <= 0) throw bad("Enter the amount paid.");
  return recordPrepaid(app, { total: fee + amt, deposit: amt, reference, by, source: "admissions" }, schema, { log });
}

/** Deposit in (marked by admissions, or seen on the HubSpot deal): deal → Deposit Paid, note, "choose your plan" email. */
async function recordPrepaid(app, { total, deposit = null, reference = "", by = "admissions", source }, schema, { log = console } = {}) {
  const appId = app.id;
  const at = new Date().toISOString();
  const amt = deposit ?? Math.max(0, total - (Number(schema?.settings?.appFee ?? 250)));
  const claimed = await db().query(
    `UPDATE applications SET enrolment = enrolment || jsonb_build_object('prepaid', $2::jsonb), updated_at = now()
      WHERE id = $1 AND NOT (enrolment ? 'prepaid') RETURNING id`,
    [appId, JSON.stringify({ amount: amt, total, reference: String(reference || "").trim().slice(0, 120) || null, at, by: String(by).slice(0, 120), source })]);
  if (!claimed.length) return { skipped: "already recorded" };
  let stage = null;
  if (hubspotOn() && app.hubspot_deal_id) {
    try {
      const deal = await HS.getDeal(app.hubspot_deal_id);
      const pipe = (await HS.dealPipelines()).find((p) => p.id === String(deal?.properties?.pipeline));
      const st = R.findStage(pipe, "depositPaid");
      if (st && R.isForward(pipe, deal?.properties?.dealstage, st)) { await HS.updateDeal(app.hubspot_deal_id, { dealstage: st.id }); stage = st.label; }
    } catch (err) { log.error?.("[mark deposit hubspot]", err.message); }
  }
  await note(app, source === "hubspot"
    ? `<p><strong>Deposit found on the deal</strong> — ${usd(total)} paid so far (payment fields), outside the acceptance page. The family has been asked to choose how to pay the rest.</p>`
    : `<p><strong>Deposit marked paid</strong> by ${esc(by)} — ${usd(amt)}${reference ? ` (${esc(reference)})` : ""}, paid outside the acceptance page. The family has been asked to choose how to pay the rest.</p>`, log);
  let email = null;
  try { email = await familyEmail(app, schema, "choosePlan", { deposit: usd(amt) }, { log }); }
  catch (err) { log.error?.("[mark deposit email]", err.message); email = { error: String(err.message).slice(0, 300) }; }
  await patchEnrolment(appId, { prepaidEmail: email });
  return { prepaid: true, amount: amt, total, stage, email };
}

/** Admissions: paid outside Stripe (e.g. a bank transfer) — mark it so it isn't charged too. */
export async function markPaidOutside(appId, idx, { by = "admissions", reference = "" } = {}, schema) {
  const ref = String(reference || "").trim().slice(0, 120) || `manual-${new Date().toISOString().slice(0, 10)}`;
  const e = await itemPaid(appId, Number(idx), { reference: ref, method: "manual", by }, schema, { from: ["scheduled", "failed", "needs_admissions", "due"], quiet: true });
  if (!e) throw bad("That payment isn't open.", 409);
  const app = await A.byId(appId);
  await note(app, `<p><strong>Marked paid outside Stripe</strong> by ${esc(by)} — ${usd(e.schedule[idx].amount)} due ${esc(e.schedule[idx].due)} (${esc(ref)}). It won't be charged automatically.</p>`);
  return e.schedule[idx];
}

/** The application behind a HubSpot deal, if `email` is the student or a parent on it. */
export async function appForPortal({ dealId, email }) {
  const em = String(email || "").trim().toLowerCase();
  if (!dealId || !em) return null;
  const rows = await db().query(`SELECT ${A.COLS}, enrolment, decision FROM applications WHERE hubspot_deal_id = $1 ORDER BY created_at DESC`, [String(dealId)]);
  const { familyRecipients } = await import("./notify.mjs");
  return rows.find((a) => familyRecipients(a).includes(em)) || null;
}

/** What the student portal shows about the payment plan. Pure (tested). */
export function portalPlan(app, { dealTotal = null } = {}) {
  const e = app?.enrolment || {};
  const d = app?.decision || null;
  // Accepted, deposit not paid yet: the portal sends them to the acceptance
  // page (plan choice, discounts, deposit) instead of its own pay buttons.
  if (d?.outcome === "accepted" && !e.withdrawn && !["paid", "processing"].includes(e.deposit?.status) && app.status !== "withdrawn") {
    const holdUntil = d.holdUntil || e.offer?.holdUntil || null;
    const paid = paidSoFar(app, e, dealTotal);
    if (e.prepaid || paid >= P.DEPOSIT_TOTAL) return { state: "choose", paid, deposit: Number(e.prepaid?.amount) || Math.max(0, paid - 250), holdPassed: false, start: e.offer?.start || null };
    return {
      state: "offer",
      paid,
      deposit: P.depositFor(paid),
      holdUntil, holdPassed: !!(holdUntil && new Date(holdUntil) < new Date()),
      start: e.offer?.start || d.offer?.start || null,
    };
  }
  if (!e.deposit || !["paid", "processing"].includes(e.deposit.status)) return null;
  const sched = (e.schedule || []).map((p, i) => ({ index: i, due: p.due, amount: p.amount, kind: p.kind, manual: !!p.manual, status: p.status, paidAt: p.paidAt || null, total: p.total ?? null }));
  const open = sched.filter((p) => p.index > 0 && ["scheduled", "failed", "needs_admissions", "due"].includes(p.status));
  const next = open.filter((p) => p.status === "scheduled" || p.status === "due").sort((a, b) => a.due.localeCompare(b.due))[0] || null;
  return {
    state: "plan",
    plan: e.choice?.plan || null,
    planName: { monthly: "Monthly payments", two: "Two instalments", full: "Paid in full", later: "Deposit now, balance later" }[e.choice?.plan] || "",
    method: e.choice?.method === "ach" ? "ach" : "card",
    schedule: sched,
    remaining: Math.round(open.reduce((a, p) => a + p.amount * 100, 0)) / 100,
    next,
    needsAction: open.some((p) => ["failed", "needs_admissions"].includes(p.status)),
    automatic: open.some((p) => !p.manual),
    paused: !!e.paused,
    withdrawn: !!e.withdrawn,
  };
}

/** A fresh personal link to the acceptance page (the portal's "manage" button). */
export async function portalLink(app) {
  return acceptLink(await A.addLinkToken(app.id));
}

/** Admissions: try a failed payment again on the next run. */
export async function retryItem(appId, idx, { by = "admissions" } = {}) {
  const e = await updateItem(appId, idx, ["failed", "needs_admissions"], { status: "failed", nextAttemptAt: new Date().toISOString(), retriedBy: String(by).slice(0, 120) });
  if (!e) throw bad("That payment isn't waiting for a retry.", 409);
  return e.schedule[idx];
}

/** Admissions: pause / resume automatic payments for one family. */
export async function setPaused(appId, paused, { by = "admissions" } = {}) {
  if (paused) return patchEnrolment(appId, { paused: { at: new Date().toISOString(), by: String(by).slice(0, 120) } });
  const rows = await db().query(`UPDATE applications SET enrolment = enrolment - 'paused', updated_at = now() WHERE id = $1 RETURNING enrolment`, [appId]);
  return rows[0]?.enrolment || null;
}

export { getPaymentIntent };
