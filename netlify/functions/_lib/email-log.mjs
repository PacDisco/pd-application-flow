// Every email sent to a family is logged on HubSpot: on the student's and each
// parent's contact timeline, and on the deal. Best-effort — the email has
// already gone, so a HubSpot problem is recorded, never retried as a resend.
//
// The HubSpot private app needs permission to create email engagements. If it
// doesn't have it, HubSpot answers 403 and the error is shown on the
// application in the dashboard (add the scope the error names, then use
// "Retry sync" — only the missing logs are written).
import * as HS from "./hubspot.mjs";

export const hubspotOn = () => !!(process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_PRIVATE_APP_TOKEN);

/** Contact IDs for the recipients: the student's from the application, the rest by email. */
async function contactIdsFor(app, to) {
  const ids = [];
  const student = String(app.email || "").toLowerCase();
  for (const email of to) {
    if (email === student && app.hubspot_contact_id) { ids.push(String(app.hubspot_contact_id)); continue; }
    const c = await HS.findContactByEmail(email).catch(() => null);
    if (c?.id) ids.push(String(c.id));
  }
  return ids;
}

/** Returns { id, contacts } or { error }. Never throws. */
export async function logFamilyEmail(app, msg, { at = new Date() } = {}) {
  if (!hubspotOn()) return { skipped: "HubSpot not configured" };
  try {
    const contactIds = await contactIdsFor(app, msg.to || []);
    if (!contactIds.length && !app.hubspot_deal_id) return { skipped: "no HubSpot contact or deal yet" };
    const r = await HS.logEmail({ ...msg, contactIds, dealId: app.hubspot_deal_id, at });
    return { id: r?.id ? String(r.id) : null, contacts: contactIds.length };
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 300) };
  }
}
