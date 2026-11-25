// Google Ads offline conversions — a CSV feed Google Ads fetches on a schedule
// (Goals → Uploads → Schedules → Source: HTTPS). No Google Ads API developer
// token needed.
//
// Why: the deposit happens days or weeks after the ad click, usually on the
// acceptance page or by wire — no Google tag sees it. Each row ties a
// conversion back to the gclid the application stored at step 1 (from the
// pd_attr cookie), so Google learns which clicks became students.
//
// Env:
//   GOOGLE_ADS_OFFLINE_NAMES  which events go in the feed and the EXACT name of
//                             the Google Ads conversion action ("Import → Clicks")
//                             for each, e.g.
//                             "deposit_paid=PD Deposit,application_submit=PD Application (offline)"
//                             Events: application_submit, application_fee_paid, deposit_paid.
//                             Don't list an event that already fires in the browser
//                             with GOOGLE_ADS_LABELS into the same action — it would count twice.
//   GOOGLE_ADS_FEED_USER / GOOGLE_ADS_FEED_PASSWORD
//                             the username/password entered in the Google Ads schedule
//   GOOGLE_ADS_FEED_EMAIL     "on" adds a hashed Email column (enhanced conversions
//                             for leads). Turn on only after enabling it in Google Ads.
//   DEPOSIT_VALUE             see tracking.mjs ("tuition" default, or "deposit")

import crypto from "node:crypto";

export const OFFLINE_EVENTS = ["application_submit", "application_fee_paid", "deposit_paid"];
const DAY = 864e5;
const CLICK_WINDOW_DAYS = 90; // Google rejects conversions more than 90 days after the click

const env = (k) => String(process.env[k] ?? "").trim();
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");

/** "deposit_paid=PD Deposit, application_submit=PD App" → { deposit_paid: "PD Deposit", … } */
export function parseNames(raw = env("GOOGLE_ADS_OFFLINE_NAMES")) {
  const out = {};
  for (const part of String(raw || "").split(/[,\n]/)) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim().replace(/[",\r\n]/g, "");
    if (OFFLINE_EVENTS.includes(k) && v) out[k] = v.slice(0, 100);
  }
  return out;
}

/** The click to credit: the latest touch with a Google click id, else the first. */
export function clickFor(attr) {
  const a = attr || {};
  for (const t of [a.last, a.first]) {
    if (t && typeof t.gclid === "string" && /^[\w-]{10,250}$/.test(t.gclid)) return { gclid: t.gclid, ts: t.ts || null };
  }
  return null;
}

/** When the deposit was paid and how much, from applications.enrolment. Pure. */
export function depositOf(enrolment) {
  const e = enrolment || {};
  if (e.withdrawn) return null;
  if (e.deposit?.status === "paid") {
    return { at: e.deposit.outside ? (e.prepaid?.at || e.deposit.paidAt) : e.deposit.paidAt, amount: Number(e.deposit.amount) || 0, reference: e.deposit.reference || null };
  }
  if (e.prepaid?.at) return { at: e.prepaid.at, amount: Number(e.prepaid.amount) || 0, reference: e.prepaid.reference || null };
  return null;
}

const fmtTime = (iso) => new Date(iso).toISOString().slice(0, 19).replace("T", " ");
const csv = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/**
 * Rows for every listed event that happened, has a gclid, and is inside the
 * 90-day click window. Pure (tested). `apps` = rows from the applications table.
 */
export function feedRows(apps, names, { now = new Date(), valueMode = env("DEPOSIT_VALUE").toLowerCase() || "tuition" } = {}) {
  const rows = [];
  for (const app of apps || []) {
    const click = clickFor(app.attribution);
    if (!click) continue;
    const clickAt = Date.parse(click.ts || "") || null;
    const add = (event, at, value, orderId) => {
      if (!names[event] || !at) return;
      const t = Date.parse(at);
      if (!Number.isFinite(t) || t > now.getTime()) return;
      if (clickAt && (t - clickAt > (CLICK_WINDOW_DAYS + 1) * DAY)) return;
      if (now.getTime() - t > CLICK_WINDOW_DAYS * DAY) return;
      rows.push({ gclid: click.gclid, name: names[event], time: fmtTime(at), value: Math.round((Number(value) || 0) * 100) / 100, currency: "USD", orderId, email: app.email });
    };
    add("application_submit", app.step2_at, 0, `sub_${app.id}`);
    if (app.paid_at) add("application_fee_paid", app.paid_at, Number(app.payment?.base ?? app.payment?.amount ?? 250), `fee_${app.id}`);
    const dep = depositOf(app.enrolment);
    if (dep) {
      const tuition = Number(app.enrolment?.offer?.tuition) || Number(app.deal_amount) || 0;
      add("deposit_paid", dep.at, valueMode === "deposit" || !tuition ? dep.amount : tuition, `dep_${app.id}`);
    }
  }
  return rows;
}

/** The CSV Google Ads expects (times in UTC). */
export function toCsv(rows, { withEmail = false } = {}) {
  const head = ["Google Click ID", "Conversion Name", "Conversion Time", "Conversion Value", "Conversion Currency", "Order ID"];
  if (withEmail) head.push("Email");
  const lines = ["Parameters:TimeZone=+0000", head.join(",")];
  for (const r of rows) {
    const cells = [r.gclid, r.name, r.time, r.value.toFixed(2), r.currency, r.orderId];
    if (withEmail) cells.push(r.email ? sha(String(r.email).trim().toLowerCase()) : "");
    lines.push(cells.map(csv).join(","));
  }
  return lines.join("\n") + "\n";
}
