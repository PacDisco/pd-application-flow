// Ad-platform tracking — config for the browser, and Meta Conversions API
// (server-side events) for the quiz and the application.
//
// Every ID lives in Netlify environment variables, so codes are added or
// changed without a code change (redeploy to pick them up):
//
//   META_PIXEL_ID          Meta (Facebook/Instagram) pixel / dataset ID
//   META_CAPI_TOKEN        Conversions API access token (Events Manager → Settings)
//   META_TEST_EVENT_CODE   optional, e.g. TEST12345 — events show under "Test events"
//   META_GRAPH_VERSION     optional, default v23.0
//   GA4_MEASUREMENT_ID     Google Analytics 4, G-XXXXXXX
//   GOOGLE_ADS_ID          Google Ads tag, AW-XXXXXXXXX
//   GOOGLE_ADS_LABELS      conversion labels per event, e.g.
//                          "quiz_lead=AbC123,application_start=DeF456,application_fee_paid=GhI789"
//   TIKTOK_PIXEL_ID        TikTok pixel
//   GTM_ID                 Google Tag Manager container, GTM-XXXXXXX (template tags only —
//                          the CSP blocks Custom HTML tags; see README)
//   TRACKING               "off" switches every browser tag and server event off
//
// Event names used across the site (browser dataLayer, GA4, Ads labels):
//   quiz_start, quiz_lead, application_start, application_submit,
//   interview_booked, application_fee_paid

import crypto from "node:crypto";
import { flag } from "./http.mjs";

export const EVENTS = ["quiz_start", "quiz_lead", "application_start", "application_submit", "interview_booked", "application_fee_paid"];

/** Meta standard event for each of ours (quiz_start stays browser-only, as a custom event). */
export const META_EVENT = {
  quiz_lead: "Lead",
  application_start: "CompleteRegistration",
  application_submit: "SubmitApplication",
  interview_booked: "Schedule",
  application_fee_paid: "Purchase",
};

const env = (k) => String(process.env[k] ?? "").trim();
export const trackingOn = () => flag("TRACKING", true);

function parseLabels(raw) {
  const out = {};
  for (const part of String(raw || "").split(/[,\n]/)) {
    const [k, v] = part.split("=").map((s) => (s || "").trim());
    if (EVENTS.includes(k) && /^[\w-]{4,64}$/.test(v)) out[k] = v;
  }
  return out;
}

/** What the browser gets (IDs only — never the CAPI token). */
export function browserConfig() {
  if (!trackingOn()) return { off: true };
  const pick = (k, re) => (re.test(env(k)) ? env(k) : undefined);
  const cfg = {
    meta: pick("META_PIXEL_ID", /^\d{6,20}$/),
    ga4: pick("GA4_MEASUREMENT_ID", /^G-[A-Z0-9]{4,16}$/i),
    ads: pick("GOOGLE_ADS_ID", /^AW-\d{6,14}$/i),
    adsLabels: parseLabels(env("GOOGLE_ADS_LABELS")),
    tiktok: pick("TIKTOK_PIXEL_ID", /^[A-Z0-9]{10,30}$/i),
    gtm: pick("GTM_ID", /^GTM-[A-Z0-9]{4,12}$/i),
  };
  return Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined));
}

// ── Meta Conversions API ─────────────────────────────────────────────────────

const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const norm = (v) => String(v ?? "").trim().toLowerCase();

/** A browser-generated event ID (shared by the pixel and CAPI so Meta de-duplicates). */
export function cleanEventId(v) {
  const s = String(v ?? "");
  return /^[\w-]{8,64}$/.test(s) ? s : null;
}

/** Stable, non-guessable event ID for the fee payment (browser and server both use it). */
export function feeEventId(appId) {
  return appId ? `fee_${sha(`pd-apply-fee:${appId}`).slice(0, 24)}` : null;
}

/** fbc from the _fbc cookie, or rebuilt from the fbclid the attribution cookie kept. */
export function fbcFor(attr) {
  const a = attr || {};
  if (a.ads?.fbc) return a.ads.fbc;
  const t = a.last?.fbclid ? a.last : a.first?.fbclid ? a.first : null;
  if (!t) return undefined;
  const ms = Date.parse(t.ts || "") || Date.now();
  return `fb.1.${ms}.${t.fbclid}`;
}

/**
 * The CAPI event body (pure — tested). `person` = { email, phone, first, last, externalId }.
 * Phone is digits only with country code, as Meta expects.
 */
export function buildMetaEvent({ name, eventId, time, sourceUrl, person = {}, attr = {}, ip, userAgent, custom = {} }) {
  const user = {};
  const em = norm(person.email);
  if (em) user.em = [sha(em)];
  const ph = String(person.phone || "").replace(/\D/g, "");
  if (ph.length >= 7) user.ph = [sha(ph)];
  if (norm(person.first)) user.fn = [sha(norm(person.first))];
  if (norm(person.last)) user.ln = [sha(norm(person.last))];
  if (person.externalId) user.external_id = [sha(String(person.externalId))];
  if (ip) user.client_ip_address = ip;
  if (userAgent) user.client_user_agent = String(userAgent).slice(0, 400);
  if (attr.ads?.fbp) user.fbp = attr.ads.fbp;
  const fbc = fbcFor(attr);
  if (fbc) user.fbc = fbc;
  const ev = {
    event_name: name,
    event_time: Math.floor((time ? new Date(time).getTime() : Date.now()) / 1000),
    action_source: "website",
    user_data: user,
    custom_data: Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== "" && v != null)),
  };
  if (eventId) ev.event_id = eventId;
  if (sourceUrl) ev.event_source_url = sourceUrl;
  return ev;
}

/** Sends one event. Never throws; resolves within ~3 s. Returns a short result for logs. */
export async function sendMeta(event) {
  const pixel = env("META_PIXEL_ID");
  const token = env("META_CAPI_TOKEN");
  if (!trackingOn() || !pixel || !token) return { skipped: "meta not configured" };
  const body = { data: [event] };
  if (env("META_TEST_EVENT_CODE")) body.test_event_code = env("META_TEST_EVENT_CODE");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`https://graph.facebook.com/${env("META_GRAPH_VERSION") || "v23.0"}/${pixel}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { console.warn("[meta capi]", event.event_name, res.status, JSON.stringify(out).slice(0, 300)); return { ok: false, status: res.status }; }
    return { ok: true, received: out.events_received };
  } catch (err) {
    console.warn("[meta capi]", event.event_name, err.message);
    return { ok: false, error: err.message };
  } finally { clearTimeout(timer); }
}

const pageFor = (attr, fallbackPath) => attr?.pageUri || `${(process.env.APPLY_SITE_URL || process.env.URL || "").replace(/\/+$/, "")}${fallbackPath}`;
const phoneOf = (m) => (m && typeof m === "object" ? `${m.cc || ""}${m.number || ""}` : String(m || ""));

/** Server-side event for an application (step 1, step 2, interview, fee). */
export function trackApplication(ours, app, { eventId, ip, userAgent } = {}) {
  const name = META_EVENT[ours];
  if (!name || !app) return Promise.resolve({ skipped: "no event" });
  const custom = { content_name: app.program || undefined, content_category: app.program_type || undefined, term: app.term || undefined };
  if (ours === "application_fee_paid") {
    custom.value = Number(app.payment?.base ?? 250);
    custom.currency = String(app.payment?.currency || "usd").toUpperCase();
    custom.order_id = app.payment?.reference || undefined;
  }
  return sendMeta(buildMetaEvent({
    name, eventId: ours === "application_fee_paid" ? feeEventId(app.id) : eventId,
    sourceUrl: pageFor(app.attribution, "/"),
    person: { email: app.email, phone: phoneOf(app.answers?.mobile), first: app.first_name, last: app.last_name, externalId: norm(app.email) },
    attr: app.attribution || {}, ip: ip || app.ip, userAgent: userAgent || app.user_agent, custom,
  }));
}

/** Server-side Lead for a quiz response. */
export function trackQuiz(row, { eventId } = {}) {
  if (!row) return Promise.resolve({ skipped: "no row" });
  const answers = row.answers || {};
  return sendMeta(buildMetaEvent({
    name: META_EVENT.quiz_lead, eventId, time: row.created_at,
    sourceUrl: pageFor(row.attribution, "/quiz"),
    person: { email: row.email, phone: phoneOf(answers.mobile) || row.phone, first: row.first_name, last: row.last_name, externalId: norm(row.email) },
    attr: row.attribution || {}, ip: row.ip, userAgent: row.user_agent,
    custom: { content_name: "Gap year quiz", archetype: row.archetype, travel_when: answers.travelWhen, travel_length: answers.travelLength },
  }));
}

// ── Website HubSpot forms (pacificdiscovery.org) ────────────────────────────
// Forms on the main site report submissions via /hs-form-tracking.js →
// POST /api/track/form. Only forms listed here are accepted; add a form by
// adding its HubSpot form GUID. `event` is the Meta event, `name` its content_name.
export const SITE_FORMS = {
  "a0bba9a0-aead-4667-81a9-5fa634fae057": { event: "Lead", name: "Program booklet request" },
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

/** Validates a browser report of a HubSpot form submission → CAPI event, or { error }. */
export function siteFormEvent(body, { ip, userAgent } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const form = SITE_FORMS[String(b.formId || "")];
  if (!form) return { error: "unknown form" };
  const f = b.fields && typeof b.fields === "object" ? b.fields : {};
  const email = String(f.email || "").trim().slice(0, 254);
  if (!EMAIL_RE.test(email)) return { error: "no email" };
  const eventId = cleanEventId(b.eventId);
  if (!eventId) return { error: "bad event id" };
  const page = /^https:\/\/([a-z0-9-]+\.)*pacificdiscovery\.org\//i.test(String(b.page || "")) ? String(b.page).slice(0, 300) : undefined;
  // Same shape the attribution kit stores: ads cookies + first/last touch from pd_attr.
  const raw = b.attr && typeof b.attr === "object" ? b.attr : {};
  const touch = (t) => (t && typeof t === "object" && typeof t.fbclid === "string" ? { fbclid: t.fbclid.slice(0, 200), ts: String(t.ts || "").slice(0, 10) } : undefined);
  const attr = { last: touch(raw.l), first: touch(raw.f) };
  const ads = b.ads && typeof b.ads === "object" ? b.ads : {};
  if (/^fb\.\d\.\d{10,16}\.\d{1,30}$/.test(String(ads.fbp || ""))) (attr.ads ||= {}).fbp = ads.fbp;
  if (/^fb\.\d\.\d{10,16}\.[\w-]+$/.test(String(ads.fbc || "")) && String(ads.fbc).length <= 500) (attr.ads ||= {}).fbc = ads.fbc;
  const str = (v, n) => String(v || "").trim().slice(0, n);
  return {
    event: buildMetaEvent({
      name: form.event, eventId, sourceUrl: page,
      person: { email, phone: str(f.phone || f.mobilephone, 40), first: str(f.firstname, 80), last: str(f.lastname, 80), externalId: email.toLowerCase() },
      attr, ip, userAgent, custom: { content_name: form.name },
    }),
  };
}
