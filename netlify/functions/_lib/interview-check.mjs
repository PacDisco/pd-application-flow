// Interviews booked OUTSIDE the application — from the "Book your interview"
// button in an email, a link admissions sent, or by admissions on a call.
// HubSpot records those as meetings on the student's contact, so before we
// email a family (and on Retry sync) we look there and mark the interview
// booked. Inside the application, step 3 records the booking directly.
//
// A meeting counts when its title matches the dashboard setting
// `interviewMatch` (default "interview", case-insensitive), it was created on
// or after the day the application was started, and it wasn't cancelled,
// rescheduled away or a no-show. The earliest upcoming one wins; otherwise the
// latest past one.
import * as HS from "./hubspot.mjs";
import { db } from "./db.mjs";

const DAY = 864e5;
const DEAD = /^(CANCELED|CANCELLED|NO_SHOW|RESCHEDULED)$/i;

export function interviewMatcher(schema) {
  const raw = String(schema?.settings?.interviewMatch || "").trim() || "interview";
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(esc, "i");
}

/** Pure: pick the interview meeting from a contact's meetings, or null. */
export function pickInterview(meetings, app, schema, now = new Date()) {
  const re = interviewMatcher(schema);
  const from = app.step1_at ? new Date(app.step1_at).getTime() - DAY : 0;
  const ok = (meetings || []).filter((m) => m.start && re.test(m.title || "") && !DEAD.test(m.outcome || "")
    && new Date(m.createdAt || m.start).getTime() >= from);
  const t = (m) => new Date(m.start).getTime();
  const upcoming = ok.filter((m) => t(m) >= now.getTime()).sort((a, b) => t(a) - t(b));
  if (upcoming.length) return upcoming[0];
  return ok.sort((a, b) => t(b) - t(a))[0] || null;
}

/** "Tuesday, November 3, 2026 at 9:00 AM MST" in admissions' timezone. */
export function interviewLabel(start, tz = process.env.INTERVIEW_TZ || "America/Denver") {
  const d = new Date(start);
  const date = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" });
  return `${date} at ${time}`;
}

/**
 * If the application has no interview yet and HubSpot has one, record it.
 * Returns the (possibly updated) application. Never throws: a HubSpot problem
 * just means we carry on as "not booked".
 */
export async function refreshInterview(app, schema, { log = console, now = new Date() } = {}) {
  if (!app || app.interview_at || !app.hubspot_contact_id) return app;
  if (!(process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_PRIVATE_APP_TOKEN)) return app;
  try {
    const m = pickInterview(await HS.contactMeetings(app.hubspot_contact_id), app, schema, now);
    if (!m) return app;
    const booking = {
      ...(app.interview || {}),
      source: "hubspot", meetingId: m.id, start: m.start, label: interviewLabel(m.start), title: m.title,
      fallback: app.interview?.fallback || undefined, foundAt: new Date().toISOString(),
    };
    const rows = await db().query(
      `UPDATE applications SET interview = $2, interview_at = COALESCE(interview_at, $3::timestamptz),
         status = CASE WHEN status IN ('step1','step2') THEN 'interview' ELSE status END, updated_at = now()
       WHERE id = $1 AND interview_at IS NULL RETURNING *`,
      [app.id, JSON.stringify(booking), m.createdAt || new Date().toISOString()]);
    return rows[0] ? { ...app, ...rows[0] } : app;
  } catch (err) {
    log.warn?.("[interview-check]", app.id, err.message);
    return app;
  }
}
