// HubSpot Forms API — the only way to get HubSpot's own "Original Source"
// right for a contact created from this site.
//
// A contact made through the CRM API (or Zapier / Make) has no visitor cookie
// attached, so HubSpot files it under "Offline Sources". Submitting to a
// HubSpot form WITH the visitor's `hubspotutk` cookie links the contact to
// every page view HubSpot tracked for that browser (on this site and on
// www.pacificdiscovery.org), and Original Source is then the real channel.
//
// The submission must CREATE the contact: if the CRM API creates it first,
// Original Source stays Offline. So the sync submits the form first, waits for
// HubSpot to process it, and only then writes everything else via the CRM API.
//
// Env: HUBSPOT_PORTAL_ID (default 3855728), HUBSPOT_TOKEN (with the `forms`
// scope the authenticated endpoint is used; without it, the public one).

import { attributionContactProps, FIRST_TOUCH_PROPS } from "../../../public/attribution-kit.mjs";
import * as HS from "./hubspot.mjs";

export const portalId = () => String(process.env.HUBSPOT_PORTAL_ID || "3855728").trim();

function token() {
  return process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
}

/** fields: { email, firstname, … } (contact properties that are on the form). */
export function submissionBody(fields, attr = {}, { ip, pageName, submittedAt = Date.now() } = {}) {
  const context = {};
  if (attr.hutk) context.hutk = attr.hutk;
  const pageUri = attr.pageUri || attr.last?.landing || attr.first?.landing;
  if (pageUri && /^https?:\/\//i.test(pageUri)) context.pageUri = pageUri;
  context.pageName = attr.pageName || pageName || "Pacific Discovery";
  // Only public addresses: HubSpot rejects private/loopback ones.
  if (ip && !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip)) context.ipAddress = ip;
  return {
    submittedAt: String(submittedAt),
    fields: Object.entries(fields)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([name, value]) => ({ objectTypeId: "0-1", name, value: String(value) })),
    context,
  };
}

/** Submit to a HubSpot form. Throws with HubSpot's message on failure. */
export async function submitForm(formGuid, body) {
  const pid = portalId();
  const t = token();
  const attempts = [];
  if (t) attempts.push({ url: `https://api.hsforms.com/submissions/v3/integration/secure/submit/${pid}/${formGuid}`, headers: { Authorization: `Bearer ${t}` } });
  attempts.push({ url: `https://api.hsforms.com/submissions/v3/integration/submit/${pid}/${formGuid}`, headers: {} });
  let last;
  for (const a of attempts) {
    const res = await fetch(a.url, { method: "POST", headers: { "Content-Type": "application/json", ...a.headers }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true, secure: a.headers.Authorization != null };
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* text */ }
    last = Object.assign(new Error(`HubSpot form ${formGuid} → ${res.status}: ${data?.errors?.map((e) => e.message).join("; ") || data?.message || text}`.slice(0, 500)), { status: res.status });
    // 401/403 on the secure endpoint = token lacks the forms scope → try the public one.
    if (!(res.status === 401 || res.status === 403)) break;
  }
  throw last;
}

/**
 * Submit the form (once), wait for the contact, then write the source
 * properties. Returns { contactId, formOk, formError, waited, dropped, created }.
 * `fields` must include email.
 */
export async function submitAndAttribute({ formGuid, fields, attr, ip, conversion, extraProps = {}, waitMs = 30000, alreadySubmitted = false }) {
  const out = { formOk: false };
  if (formGuid && !alreadySubmitted) {
    // If the HubSpot form lacks a field we send, it rejects the submission —
    // retry with the email alone (everything else goes in via the CRM below).
    const tries = [fields, { email: fields.email }];
    for (const f of tries) {
      try {
        await submitForm(formGuid, submissionBody(f, attr, { ip }));
        out.formOk = true; out.formError = undefined; break;
      } catch (err) { out.formError = err.message; if (err.status !== 400) break; }
    }
  } else if (alreadySubmitted) out.formOk = true;

  let contact = null;
  if (out.formOk) {
    const t0 = Date.now();
    contact = await HS.waitForContact(fields.email, { timeoutMs: waitMs });
    out.waited = Date.now() - t0;
  }
  let existing = {};
  if (!contact) {
    // No form, form failed, or HubSpot hasn't processed it yet: create/update via the CRM API.
    const c = await HS.upsertContact(fields.email, fields);
    out.contactId = c.id; out.created = c.created; out.dropped = c.dropped;
    if (out.formOk) out.note = "form not processed in time — contact written via CRM";
  } else {
    out.contactId = String(contact.id);
  }
  try {
    const cur = await HS.getContact(out.contactId, [...FIRST_TOUCH_PROPS, "hs_lead_status"]);
    existing = cur?.properties || {};
  } catch { /* treat as empty */ }
  const props = { ...attributionContactProps(attr, existing, { conversion }), ...extraProps };
  if (extraProps.hs_lead_status && existing.hs_lead_status) delete props.hs_lead_status; // never reset a working lead
  const p = await HS.patchContact(out.contactId, props);
  out.dropped = [...(out.dropped || []), ...p.dropped];
  return out;
}
