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
