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

/** Wraps a message (Markdown subset) + optional terms in the email layout. Pure. */
export function familyEmailHtml(messageMd, terms) {
  const termsBlock = terms ? `
  <tr><td style="padding:24px 28px 8px;border-top:1px solid #e1e6e8">
    <p style="font-size:12px;color:#5f666b;margin:0 0 6px;text-transform:uppercase;letter-spacing:.04em">${esc(terms.title)} · version ${esc(terms.version)}</p>
    <p style="font-size:12px;color:#5f666b;margin:0 0 14px">Also online at <a href="${esc(termsUrl(terms.version))}" style="color:#288195">${esc(termsUrl(terms.version))}</a></p>
    ${TK.termsToEmailHtml(terms.body, { size: 12 })}
  </td></tr>` : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #e1e6e8;border-radius:12px;font-family:Arial,Helvetica,sans-serif">
  <tr><td style="background:#288195;border-radius:12px 12px 0 0;padding:18px 28px;color:#ffffff;font-size:18px;font-weight:bold">Pacific Discovery</td></tr>
  <tr><td style="padding:26px 28px 14px">${TK.termsToEmailHtml(messageMd, { size: 15 })}</td></tr>${termsBlock}
</table></td></tr></table></body></html>`;
}

export function familyEmailText(messageMd, terms) {
  const parts = [TK.termsToText(messageMd)];
  if (terms) parts.push("", "------------------------------------------------------------", `${terms.title} (version ${terms.version})`, termsUrl(terms.version), "", TK.termsToText(terms.body));
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
        : "Our admissions team will be in touch to arrange your interview.",
    termsUrl: termsUrl(terms?.version),
  };
  // "({term})" with no term reads badly — drop the empty brackets.
  const body = TK.fillTemplate(tpl.body, vars).replace(/\s*\(\s*\)/g, "");
  const subject = TK.fillTemplate(tpl.subject, vars).replace(/\s*\(\s*\)/g, "");
  return { subject, text: familyEmailText(body, terms), html: familyEmailHtml(body, terms), enabled: tpl.enabled };
}

export async function sendFeeConfirmation(app, schema, terms) {
  const to = familyRecipients(app);
  if (!to.length) throw new Error("No valid recipient email");
  const { subject, text, html } = feeConfirmationContent(app, schema, terms);
  const { from, replyTo } = applicantFrom();
  await transport().sendMail({ from, to: to.join(", "), replyTo, subject, text, html });
  return to;
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
