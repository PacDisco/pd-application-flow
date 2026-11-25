// Sends the deposit to the ad platforms exactly once per application, however
// it arrived (acceptance page, wire marked by admissions, or found on the deal).
// The claim is atomic on applications.enrolment.adsDeposit, so the return page,
// the Stripe webhook and the hourly payment run can't send it twice.
import { db } from "./db.mjs";
import * as A from "./applications.mjs";
import { trackDeposit } from "./tracking.mjs";
import { depositOf } from "./google-offline.mjs";

export async function trackDepositOnce(appId, { log = console } = {}) {
  try {
    const at = new Date().toISOString();
    const rows = await db().query(
      `UPDATE applications
          SET enrolment = COALESCE(enrolment, '{}'::jsonb) || jsonb_build_object('adsDeposit', $2::jsonb)
        WHERE id = $1 AND NOT (COALESCE(enrolment, '{}'::jsonb) ? 'adsDeposit')
        RETURNING enrolment`,
      [appId, JSON.stringify({ at })]);
    if (!rows.length) return { skipped: "already sent" };
    const enrolment = rows[0].enrolment || {};
    const dep = depositOf(enrolment);
    const app = await A.byId(appId);
    if (!dep || !app) return { skipped: "no deposit" };
    const tuition = Number(enrolment.offer?.tuition) || Number(app.deal_amount) || 0;
    const r = await trackDeposit(app, { deposit: dep.amount, tuition, reference: `dep_${appId}`, at: dep.at });
    const brief = (x) => (x?.ok ? "ok" : x?.skipped || x?.error || `status ${x?.status ?? "?"}`);
    await db().query(
      `UPDATE applications SET enrolment = enrolment || jsonb_build_object('adsDeposit', $2::jsonb) WHERE id = $1`,
      [appId, JSON.stringify({ at, meta: brief(r.meta), tiktok: brief(r.tiktok) })]);
    return r;
  } catch (err) {
    log.error?.("[deposit tracking]", err.message);
    return { ok: false, error: err.message };
  }
}
