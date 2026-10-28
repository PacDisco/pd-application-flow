// Admissions alerts by email (same Gmail / Workspace SMTP setup as the
// student portal's magic-link and message-board emails).
//
// Env:
//   SMTP_USER                mailbox we send AS (Google Workspace)
//   SMTP_PASS                Google App Password for that mailbox
//   SMTP_FROM_NAME           optional, default "Pacific Discovery Applications"
//   ADMISSIONS_ALERT_EMAIL   optional, default admissions@pacificdiscovery.org
//                            (comma-separate for several; "off" disables)
//   DASHBOARD_URL            optional, default https://dashboard.pacificdiscovery.org

import nodemailer from "nodemailer";
import * as K from "../../../public/form-kit.mjs";
import * as P from "../../../public/plans-kit.mjs";

const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "3855728";

export function alertRecipients() {
  const raw = (process.env.ADMISSIONS_ALERT_EMAIL || "admissions@pacificdiscovery.org").trim();
  if (/^(off|none|false|0)$/i.test(raw)) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export function alertOn() {
  return alertRecipients().length > 0 && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
}

let _transport = null;
export function __setTransport(t) { _transport = t; }
function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transport;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Subject, plain text and HTML for the "new applicant" alert. Pure (tested). */
export function step1AlertContent(app, schema) {
  const a = app.answers || {};
  const name = `${app.first_name || ""} ${app.last_name || ""}`.trim() || app.email;
  const rows = [];
  for (const f of K.stepFields(schema, "step1")) {
    if (!K.isInput(f) || f.type === "hidden" || f.key === "dealAmount") continue;
    const v = a[f.key];
    if (v == null || v === "") continue;
    rows.push([f.label || f.key, K.valueText(f, v)]);
  }
  if (a.dealAmount) rows.push(["Program price", `$${Number(a.dealAmount).toLocaleString("en-US")}`]);
  const attr = app.attribution || {};
  const src = [a.utm_source || attr.utm_source, a.utm_medium || attr.utm_medium, a.utm_campaign || attr.utm_campaign].filter(Boolean).join(" / ");
  if (src) rows.push(["Source", src]);
  if (a.gclid || attr.gclid) rows.push(["Google Ads click", "yes (gclid)"]);
  if (a.fbclid || attr.fbclid) rows.push(["Meta ad click", "yes (fbclid)"]);
  if (attr.landing) rows.push(["Landing page", attr.landing]);

  const dash = (process.env.DASHBOARD_URL || "https://dashboard.pacificdiscovery.org").replace(/\/+$/, "");
  const links = [];
  if (app.hubspot_contact_id) links.push(["Open contact in HubSpot", `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${app.hubspot_contact_id}`]);
  if (app.hubspot_deal_id) links.push(["Open deal in HubSpot", `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${app.hubspot_deal_id}`]);
  links.push(["See all applications", `${dash}/apply-form/`]);

  const subject = `New application started: ${name}${app.program ? ` — ${app.program}` : ""}${app.term ? ` (${app.term})` : ""}`;
  const text = [
    `${name} has completed step 1 of the online application.`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Next for them: full application → interview booking → $250 application fee.",
    "",
    ...links.map(([k, u]) => `${k}: ${u}`),
  ].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2f2f2f;max-width:620px">
  <p style="font-size:16px;margin:0 0 12px"><strong>${esc(name)}</strong> has completed step 1 of the online application.</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #e1e6e8">
    ${rows.map(([k, v]) => `<tr><td style="background:#f6f8f9;border-bottom:1px solid #e1e6e8;width:38%;color:#5f666b">${esc(k)}</td><td style="border-bottom:1px solid #e1e6e8">${esc(v)}</td></tr>`).join("")}
  </table>
  <p style="color:#5f666b;margin:12px 0">Next for them: full application → interview booking → $250 application fee.</p>
  <p>${links.map(([k, u]) => `<a href="${esc(u)}" style="color:#288195;margin-right:16px">${esc(k)}</a>`).join("")}</p>
</div>`;
  return { subject, text, html };
}

/** Sends the alert; returns the recipient list. */
export async function sendStep1Alert(app, schema) {
  const to = alertRecipients();
  const { subject, text, html } = step1AlertContent(app, schema);
  await transport().sendMail({
    from: `"${process.env.SMTP_FROM_NAME || "Pacific Discovery Applications"}" <${process.env.SMTP_USER}>`,
    to: to.join(", "),
    replyTo: app.email,
    subject, text, html,
  });
  return to;
}

/** "Interview needed" alert content (pure; tested). */
export function interviewNeededContent(app, schema) {
  const a = app.answers || {};
  const fb = app.interview || {};
  const name = `${app.first_name || ""} ${app.last_name || ""}`.trim() || app.email;
  const phone = (v) => (v && v.number ? `${v.cc ? `+${v.cc} ` : ""}${v.number}` : "");
  const rows = [
    ["Reason", fb.reasonLabel || fb.reason || ""],
    ...(fb.note ? [["Their note", fb.note]] : []),
    ["Program", [app.program, app.term].filter(Boolean).join(" · ")],
    ["Student email", app.email],
    ["Student phone", phone(a.mobile)],
    ...[1, 2].flatMap((n) => {
      const nm = a[`parent${n}Name`]; const em = a[`parent${n}Email`];
      if (!nm && !em) return [];
      const who = n === 1 ? "Primary parent/guardian" : "Secondary parent/guardian";
      return [[who, [nm ? `${nm.first || ""} ${nm.last || ""}`.trim() : "", em, phone(a[`parent${n}Phone`])].filter(Boolean).join(" · ")]];
    }),
  ].filter(([, v]) => v);
  const dash = (process.env.DASHBOARD_URL || "https://dashboard.pacificdiscovery.org").replace(/\/+$/, "");
  const links = [];
  if (app.hubspot_contact_id) links.push(["Open contact in HubSpot", `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${app.hubspot_contact_id}`]);
  if (app.hubspot_deal_id) links.push(["Open deal in HubSpot", `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${app.hubspot_deal_id}`]);
  links.push(["See all applications", `${dash}/apply-form/`]);
  const subject = `Interview needed: ${name}${app.program ? ` — ${app.program}` : ""}${app.term ? ` (${app.term})` : ""}`;
  const intro = `${name} finished their application but couldn't book an interview online, so they've gone on to the application fee. Please contact them to arrange the interview.`;
  const text = [intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", ...links.map(([k, u]) => `${k}: ${u}`)].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2f2f2f;max-width:620px">
  <p style="font-size:16px;margin:0 0 12px">${esc(intro)}</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #e1e6e8">
    ${rows.map(([k, v]) => `<tr><td style="background:#f6f8f9;border-bottom:1px solid #e1e6e8;width:38%;color:#5f666b">${esc(k)}</td><td style="border-bottom:1px solid #e1e6e8;white-space:pre-wrap">${esc(v)}</td></tr>`).join("")}
  </table>
  <p>${links.map(([k, u]) => `<a href="${esc(u)}" style="color:#288195;margin-right:16px">${esc(k)}</a>`).join("")}</p>
</div>`;
  return { subject, text, html };
}

export async function sendInterviewNeededAlert(app, schema) {
  const to = alertRecipients();
  const { subject, text, html } = interviewNeededContent(app, schema);
  await transport().sendMail({
    from: `"${process.env.SMTP_FROM_NAME || "Pacific Discovery Applications"}" <${process.env.SMTP_USER}>`,
    to: to.join(", "), replyTo: app.email, subject, text, html,
  });
  return to;
}

// ── applicant emails (student + parents) ───────────────────────────────────
//
// Sent AS `APPLICANT_FROM_EMAIL` (default admissions@pacificdiscovery.org),
// reply-to the same. Gmail only honours a From that the SMTP_USER mailbox may
// send as: add admissions@ under that mailbox's Settings → Accounts →
// "Send mail as" (or use the admissions@ mailbox itself as SMTP_USER),
// otherwise Gmail quietly rewrites From to SMTP_USER.

import * as TK from "../../../public/terms-kit.mjs";
import { parentContacts } from "./routing.mjs";

export function mailOn() { return !!process.env.SMTP_USER && !!process.env.SMTP_PASS; }

export function applicantFrom() {
  const addr = (process.env.APPLICANT_FROM_EMAIL || "admissions@pacificdiscovery.org").trim();
  const name = process.env.APPLICANT_FROM_NAME || "Pacific Discovery Admissions";
  return { from: `"${name}" <${addr}>`, replyTo: addr };
}

/** Student first, then each parent/guardian email from the application (deduped). */
export function familyRecipients(app) {
  const student = String(app.email || "").trim().toLowerCase();
  const parents = parentContacts(app.answers || {}, student).map((p) => p.props.email);
  return [student, ...parents].filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

const usd = (n, cur = "usd") => {
  const v = Number(n) || 0;
  // $250 rather than $250.00; cents only when there are some ($258.75).
  return new Intl.NumberFormat("en-US", { style: "currency", currency: String(cur || "usd").toUpperCase(), minimumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);
};

function termsUrl(version) {
  const base = (process.env.APPLY_SITE_URL || process.env.URL || "https://apply.pacificdiscovery.org").replace(/\/+$/, "");
  return `${base}/terms${version ? `?v=${version}` : ""}`;
}

export const EMAIL_LOGO_URL = process.env.EMAIL_LOGO_URL
  || "https://comms.pureexploration.nz/hs-fs/hubfs/PD-Logo-Colour-Stacked.png?width=560&upscale=true&name=PD-Logo-Colour-Stacked.png";

/**
 * Wraps a message (Markdown subset) in the email layout. A link on its own line
 * becomes a button. `terms` adds a button to that version of the Program Terms
 * & Conditions — the terms themselves are not copied into the email. Pure.
 */
export function familyEmailHtml(messageMd, terms, advisor = null) {
  const advisorRow = advisor ? `
  <tr><td style="padding:18px 28px 6px;border-top:1px solid #e1e6e8;background:#f6fbfc">
    <p style="font-size:14px;line-height:1.5;color:#3a3a3a;margin:0 0 8px">${esc(advisor.text)}</p>
    ${TK.emailButton(advisor.label, advisor.url, { secondary: true })}
  </td></tr>` : "";
  const termsBlock = terms ? `
  <tr><td style="padding:18px 28px 22px;border-top:1px solid #e1e6e8">
    <p style="font-size:13px;line-height:1.5;color:#5f666b;margin:0 0 8px">Your place is subject to our ${esc(terms.title)} (version ${esc(terms.version)}).</p>
    ${TK.emailButton(`View the ${terms.title}`, termsUrl(terms.version), { secondary: true })}
  </td></tr>` : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #e1e6e8;border-radius:12px;font-family:Arial,Helvetica,sans-serif">
  <tr><td align="center" style="padding:26px 28px 18px;border-bottom:4px solid #288195;border-radius:12px 12px 0 0"><img src="${esc(EMAIL_LOGO_URL)}" width="220" alt="Pacific Discovery" style="display:block;width:220px;max-width:70%;height:auto;border:0"></td></tr>
  <tr><td style="padding:26px 28px 10px">${TK.termsToEmailHtml(messageMd, { size: 15, buttons: true })}</td></tr>${advisorRow}${termsBlock}
</table>
<p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8a9296;margin:14px 0 0">Pacific Discovery · EDA Group Limited · <a href="https://www.pacificdiscovery.org" style="color:#8a9296">pacificdiscovery.org</a></p>
</td></tr></table></body></html>`;
}

export function familyEmailText(messageMd, terms, advisor = null) {
  const parts = [TK.termsToText(messageMd)];
  if (advisor) parts.push("", `${advisor.text}`, `${advisor.label}: ${advisor.url}`);
  if (terms) parts.push("", `${terms.title} (version ${terms.version}): ${termsUrl(terms.version)}`);
  return parts.join("\n");
}

/** Subject, text and HTML for the "application fee received" email. Pure (tested). */
export function feeConfirmationContent(app, schema, terms) {
  const tpl = TK.emailTemplate(schema, "feeConfirmation");
  const pay = app.payment || {};
  const cur = pay.currency || schema?.settings?.currency || "usd";
  const paidAt = app.paid_at || pay.paidAt;
  const vars = {
    firstName: app.answers?.preferredName || app.first_name || "there",
    studentName: `${app.first_name || ""} ${app.last_name || ""}`.trim(),
    program: app.program || "your Pacific Discovery program",
    term: app.term || "",
    fee: usd(pay.base ?? schema?.settings?.appFee ?? 250, cur),
    total: usd(pay.total ?? pay.base ?? 250, cur),
    date: paidAt ? new Date(paidAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "",
    reference: pay.reference || "",
    interview: app.interview_at && app.interview?.label
      ? `Your interview is booked for ${app.interview.label}.`
      : app.interview_at ? "Your interview is booked — check your calendar invite for the time."
        : "Book your admissions interview using the button above.",
    // Not booked yet → the email's main button is "Book your interview".
    interviewButton: app.interview_at ? "" : `**Next step: book your interview**\n\n[Book your interview](${TK.interviewBookingUrl(schema, app)})`,
    termsUrl: termsUrl(terms?.version),
  };
  // "({term})" with no term reads badly — drop the empty brackets.
  const body = TK.fillTemplate(tpl.body, vars).replace(/\s*\(\s*\)/g, "");
  const subject = TK.fillTemplate(tpl.subject, vars).replace(/\s*\(\s*\)/g, "");
  const advisor = TK.advisorBlock(schema);
  return { subject, text: familyEmailText(body, terms, advisor), html: familyEmailHtml(body, terms, advisor), enabled: tpl.enabled };
}

export async function sendFeeConfirmation(app, schema, terms) {
  const to = familyRecipients(app);
  if (!to.length) throw new Error("No valid recipient email");
  const { subject, text, html } = feeConfirmationContent(app, schema, terms);
  const { from, replyTo } = applicantFrom();
  await transport().sendMail({ from, to: to.join(", "), replyTo, subject, text, html });
  return { to, from, subject, text, html };
}

/** "Fee paid" alert to admissions@. Pure (tested). */
export function feePaidAlertContent(app) {
  const name = `${app.first_name || ""} ${app.last_name || ""}`.trim() || app.email;
  const pay = app.payment || {};
  const dash = (process.env.DASHBOARD_URL || "https://dashboard.pacificdiscovery.org").replace(/\/+$/, "");
  const links = [];
  if (app.hubspot_deal_id) links.push(["Open deal in HubSpot", `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${app.hubspot_deal_id}`]);
  links.push(["See all applications", `${dash}/apply-form/`]);
  const interview = app.interview_at ? `Interview: ${app.interview?.label || "booked"}` : "Interview: not booked yet — please arrange it";
  const subject = `Application fee paid: ${name}${app.program ? ` — ${app.program}` : ""}${app.term ? ` (${app.term})` : ""}`;
  const lines = [`${name} has paid the application fee (${usd(pay.total ?? 0, pay.currency)}).`, interview, "", ...links.map(([k, u]) => `${k}: ${u}`)];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2f2f2f;max-width:620px">
  <p style="font-size:16px;margin:0 0 8px"><strong>${esc(name)}</strong> has paid the application fee (${esc(usd(pay.total ?? 0, pay.currency))}).</p>
  <p style="margin:0 0 12px">${esc(interview)}</p>
  <p>${links.map(([k, u]) => `<a href="${esc(u)}" style="color:#288195;margin-right:16px">${esc(k)}</a>`).join("")}</p></div>`;
  return { subject, text: lines.join("\n"), html };
}

export async function sendFeePaidAlert(app) {
  const to = alertRecipients();
  const { subject, text, html } = feePaidAlertContent(app);
  await transport().sendMail({
    from: `"${process.env.SMTP_FROM_NAME || "Pacific Discovery Applications"}" <${process.env.SMTP_USER}>`,
    to: to.join(", "), replyTo: app.email, subject, text, html,
  });
  return to;
}

// ── application fee not paid: reminders ────────────────────────────────────

function interviewDone(app, schema) {
  const iv = app.interview || {};
  return !!(app.interview_at || iv.reused || iv.fallback || (iv.skipped && schema?.settings?.allowSkipInterview));
}

/** Subject, text and HTML for reminder `stage` (1–4). Pure (tested). */
export function feeReminderContent(app, schema, stage, { link, closeDate } = {}) {
  const tpl = TK.emailTemplate(schema, `feeReminder${stage}`);
  const fee = usd(schema?.settings?.appFee ?? 250, schema?.settings?.currency);
  const vars = {
    firstName: app.answers?.preferredName || app.first_name || "there",
    program: app.program || "your Pacific Discovery program",
    term: app.term || "",
    fee,
    link: link || "",
    nextStep: interviewDone(app, schema)
      ? `pay the ${fee} application fee so we can review your application.`
      : `book your interview and pay the ${fee} application fee.`,
    closeDate: closeDate ? new Date(closeDate).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : "",
  };
  const body = TK.fillTemplate(tpl.body, vars).replace(/\s*\(\s*\)/g, "");
  const subject = TK.fillTemplate(tpl.subject, vars).replace(/\s*\(\s*\)/g, "");
  const advisor = TK.advisorBlock(schema);
  return { subject, text: familyEmailText(body, null, advisor), html: familyEmailHtml(body, null, advisor), enabled: tpl.enabled };
}

export async function sendFeeReminder(app, schema, stage, opts) {
  const to = familyRecipients(app);
  if (!to.length) throw new Error("No valid recipient email");
  const { subject, text, html } = feeReminderContent(app, schema, stage, opts);
  const { from, replyTo } = applicantFrom();
  await transport().sendMail({ from, to: to.join(", "), replyTo, subject, text, html });
  return { to, from, subject, text, html };
}

// ── decision: not accepted ─────────────────────────────────────────────────

/** Subject, text and HTML for the "not accepted" email. Pure (tested). */
export function declinedContent(app, schema, { message = "", refund = null } = {}) {
  const tpl = TK.emailTemplate(schema, "declined");
  const cur = app.payment?.currency || schema?.settings?.currency || "usd";
  const vars = {
    firstName: app.answers?.preferredName || app.first_name || "there",
    program: app.program || "your Pacific Discovery program",
    term: app.term || "",
    message: String(message || "").trim(),
    refund: refund?.amount
      ? `We've refunded your application fee of ${usd(refund.amount / 100, cur)} to the card you paid with. It usually shows on your statement within 5–10 business days.`
      : "",
  };
  const body = TK.fillTemplate(tpl.body, vars).replace(/\s*\(\s*\)/g, "");
  const subject = TK.fillTemplate(tpl.subject, vars).replace(/\s*\(\s*\)/g, "");
  return { subject, text: familyEmailText(body, null), html: familyEmailHtml(body, null), enabled: tpl.enabled };
}

export async function sendDeclined(app, schema, opts) {
  const to = familyRecipients(app);
  if (!to.length) throw new Error("No valid recipient email");
  const { subject, text, html } = declinedContent(app, schema, opts);
  const { from, replyTo } = applicantFrom();
  await transport().sendMail({ from, to: to.join(", "), replyTo, subject, text, html });
  return { to, from, subject, text, html };
}

// ── acceptance + enrolment ─────────────────────────────────────────────────
const longDate = (d) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${d}T12:00:00Z` : d)
  .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDate = (d) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${d}T12:00:00Z` : d)
  .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Congratulations — you're accepted" with the personal confirm link. Pure (tested). */
export function acceptedContent(app, schema, { offer, link, terms = null, message = "", now = new Date() } = {}) {
  const tpl = TK.emailTemplate(schema, "accepted");
  // What they'll be offered on the page depends on how close the start is.
  let howToPay = `You'll pay your ${usd(offer?.deposit ?? 2250)} deposit and choose how to pay the rest of your tuition.`;
  if (offer?.start && offer?.tuition) {
    const o = P.paymentOptions({ tuition: offer.tuition, paid: offer.paid ?? 250, deposit: offer.deposit, start: offer.start, today: P.iso(now), discounts: offer.discounts || { full: offer.payInFullDiscount || 0 } });
    const fullOpt = o.options.find((x) => x.key === "full");
    const twoOpt = o.options.find((x) => x.key === "two");
    const keys = o.options.map((x) => x.key);
    if (!(offer.deposit > 0)) howToPay = "We've already received your deposit, so you'll just choose how to pay the rest of your tuition.";
    else if (keys.includes("monthly")) howToPay = `You'll pay your ${usd(offer.deposit)} deposit and choose how to pay the rest of your tuition — monthly, in two instalments, or in full.`;
    else if (keys.includes("two")) howToPay = `You'll choose to pay your tuition in two instalments or in full.`;
    else howToPay = `As your program starts in less than ${P.TWO_MIN_DAYS} days, the remaining tuition of ${usd(fullOpt.payments[0].amount)}${fullOpt.discount ? ` (after your ${usd(fullOpt.discount)} pay-in-full discount)` : ""} is due when you confirm.`;
    const saves = [];
    if (keys.length > 1 && fullOpt?.discount) saves.push(`pay in full and save ${usd(fullOpt.discount)}`);
    if (twoOpt?.discount) saves.push(`pay in two instalments and save ${usd(twoOpt.discount)}`);
    if (saves.length) howToPay += ` ${saves.join(", or ").replace(/^./, (c) => c.toUpperCase())} — these savings are only available until ${shortDate(P.discountLastDay(offer.start))}.`;
  }
  const vars = {
    firstName: app.answers?.preferredName || app.first_name || "there",
    program: app.program || "your Pacific Discovery program",
    term: app.term || "",
    startDate: offer?.start ? longDate(offer.start) : "",
    // A moment in time: shown as the date in admissions' time zone.
    holdUntil: offer?.holdUntil ? new Date(offer.holdUntil).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: process.env.INTERVIEW_TZ || "America/Denver" }) : "",
    deposit: usd(offer?.deposit ?? 2250),
    tuition: usd(offer?.tuition ?? 0),
    howToPay,
    message: String(message || "").trim(),
    link: link || "",
  };
  const body = TK.fillTemplate(tpl.body, vars).replace(/\s*\(\s*\)/g, "").replace(/, starting \./, ".");
  const subject = TK.fillTemplate(tpl.subject, vars);
  const advisor = TK.advisorBlock(schema);
  return { subject, text: familyEmailText(body, terms, advisor), html: familyEmailHtml(body, terms, advisor), enabled: tpl.enabled };
}

export async function sendAccepted(app, schema, opts) {
  const to = familyRecipients(app);
  if (!to.length) throw new Error("No valid recipient email");
  const { subject, text, html } = acceptedContent(app, schema, opts);
  const { from, replyTo } = applicantFrom();
  await transport().sendMail({ from, to: to.join(", "), replyTo, subject, text, html });
  return { to, from, subject, text, html };
}

export const PLAN_NAMES = { monthly: "Monthly payments", two: "Two instalments", full: "Paid in full", later: "Deposit now, balance later" };

/** "Your place is confirmed" — plan, schedule, portal. Pure (tested). */
export function enrolledContent(app, schema, { enrolment, terms = null, payOff = null } = {}) {
  const tpl = TK.emailTemplate(schema, "enrolled");
  const e = enrolment || {};
  const method = e.choice?.method === "ach" ? "bank account" : "card";
  const later = (e.schedule || []).filter((p) => p.kind !== "deposit");
  const schedule = later.length
    ? later.map((p) => `- ${shortDate(p.due)} — ${usd(p.amount)}${p.manual ? " (due by this date)" : ""}`).join("\n")
    : "- Nothing more to pay — your tuition is paid in full. Thank you!";
  const auto = later.filter((p) => !p.manual);
  const manual = later.filter((p) => p.manual);
  const notes = [];
  const rate = Number(e.lastPending?.rate ?? K.surchargeRates(schema)[e.choice?.method === "ach" ? "ach" : "card"]) || 0;
  const feeNote = rate > 0 ? ` A ${(rate * 100).toFixed(1).replace(/\.0$/, "")}% processing fee is added to each ${method} payment.` : "";
  if (auto.length) notes.push(`We'll charge ${auto.length === 1 ? "this" : "these"} automatically to the ${method} you used today and email you 3 days before each payment.${feeNote}`);
  if (e.deposit?.discount && e.choice?.plan === "two") notes.push(`Your ${usd(e.deposit.discount)} two-instalment discount has been taken off your final payment.`);
  if (payOff?.amount) notes.push(`Pay your balance by ${shortDate(payOff.until)} and we'll take ${usd(payOff.amount)} off — the same saving as paying in full. You can pay any time from the student portal or your confirmation page.`);
  if (manual.length) notes.push(`Please pay the remaining ${usd(manual[0].amount)} by ${shortDate(manual[0].due)} — you can pay any time before then from the student portal.`);
  const vars = {
    firstName: app.answers?.preferredName || app.first_name || "there",
    program: app.program || "your Pacific Discovery program",
    term: app.term || "",
    paidToday: `${usd(e.deposit?.total ?? e.deposit?.amount ?? 0)}${e.deposit?.discount && e.choice?.plan !== "two" ? ` (that includes your ${usd(e.deposit.discount)} pay-in-full discount)` : ""}`,
    planName: PLAN_NAMES[e.choice?.plan] || "",
    schedule,
    scheduleNote: notes.join(" "),
    email: app.email,
    portalUrl: (process.env.PORTAL_BASE_URL || "https://portal.pacificdiscovery.org").replace(/\/+$/, "") + "/login.html",
  };
  const body = TK.fillTemplate(tpl.body, vars).replace(/\s*\(\s*\)/g, "");
  const subject = TK.fillTemplate(tpl.subject, vars);
  const advisor = TK.advisorBlock(schema);
  return { subject, text: familyEmailText(body, terms, advisor), html: familyEmailHtml(body, terms, advisor), enabled: tpl.enabled };
}

export async function sendEnrolled(app, schema, opts) {
  const to = familyRecipients(app);
  if (!to.length) throw new Error("No valid recipient email");
  const { subject, text, html } = enrolledContent(app, schema, opts);
  const { from, replyTo } = applicantFrom();
  await transport().sendMail({ from, to: to.join(", "), replyTo, subject, text, html });
  return { to, from, subject, text, html };
}

/** Admissions: deposit paid. */
export async function sendDepositAlert(app, enrolment) {
  const to = alertRecipients();
  if (!to.length) return [];
  const name = `${app.first_name || ""} ${app.last_name || ""}`.trim() || app.email;
  const plan = PLAN_NAMES[enrolment?.choice?.plan] || "";
  const subject = `Deposit paid: ${name}${app.program ? ` — ${app.program}` : ""}${app.term ? ` (${app.term})` : ""}`;
  const text = `${name} has paid ${usd(enrolment?.deposit?.total ?? 0)} and confirmed their place. Plan: ${plan}.`;
  await transport().sendMail({
    from: `"${process.env.SMTP_FROM_NAME || "Pacific Discovery Applications"}" <${process.env.SMTP_USER}>`,
    to: to.join(", "), replyTo: app.email, subject, text, html: `<p style="font-family:Arial,sans-serif;font-size:14px">${esc(text)}</p>`,
  });
  return to;
}

// ── payments after the deposit (stage 4b) ──────────────────────────────────

export { usd as formatUsd };

/**
 * Any editable family email by template key, with the standard layout.
 * `vars` fill the placeholders; firstName / program / term are added.
 * Pure (tested). Advisor block off for payment notices unless `advisor`.
 */
export function familyMessage(app, schema, key, vars = {}, { terms = null, advisor = false } = {}) {
  const tpl = TK.emailTemplate(schema, key);
  const all = {
    firstName: app.answers?.preferredName || app.first_name || "there",
    program: app.program || "your Pacific Discovery program",
    term: app.term || "",
    ...vars,
  };
  const body = TK.fillTemplate(tpl.body, all).replace(/\s*\(\s*\)/g, "").replace(/\n{3,}/g, "\n\n");
  const subject = TK.fillTemplate(tpl.subject, all).replace(/\s*\(\s*\)/g, "");
  const adv = advisor ? TK.advisorBlock(schema) : null;
  return { subject, text: familyEmailText(body, terms, adv), html: familyEmailHtml(body, terms, adv), enabled: tpl.enabled };
}

export async function sendFamily(app, schema, key, vars, opts) {
  const to = familyRecipients(app);
  if (!to.length) throw new Error("No valid recipient email");
  const { subject, text, html } = familyMessage(app, schema, key, vars, opts);
  const { from, replyTo } = applicantFrom();
  await transport().sendMail({ from, to: to.join(", "), replyTo, subject, text, html });
  return { to, from, subject, text, html };
}

/** A plain alert to admissions@ about one applicant. */
export async function sendAdmissionsAlert(app, subject, lines) {
  const to = alertRecipients();
  if (!to.length) return [];
  const name = `${app.first_name || ""} ${app.last_name || ""}`.trim() || app.email;
  const links = [];
  if (app.hubspot_deal_id) links.push(["Open deal in HubSpot", `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${app.hubspot_deal_id}`]);
  links.push(["Applications dashboard", `${(process.env.DASHBOARD_URL || "https://dashboard.pacificdiscovery.org").replace(/\/+$/, "")}/apply-form/`]);
  const full = `${subject}: ${name}${app.program ? ` — ${app.program}` : ""}${app.term ? ` (${app.term})` : ""}`;
  const text = [...lines, "", ...links.map(([k, u]) => `${k}: ${u}`)].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2f2f2f;max-width:620px">${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("")}
  <p>${links.map(([k, u]) => `<a href="${esc(u)}" style="color:#288195;margin-right:16px">${esc(k)}</a>`).join("")}</p></div>`;
  await transport().sendMail({
    from: `"${process.env.SMTP_FROM_NAME || "Pacific Discovery Applications"}" <${process.env.SMTP_USER}>`,
    to: to.join(", "), replyTo: app.email, subject: full, text, html,
  });
  return to;
}
