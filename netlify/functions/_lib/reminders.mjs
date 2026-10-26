// Application-fee reminders.
//
// Who: the full application is in (step2_at), the fee isn't paid, the
// application isn't withdrawn, and admissions hasn't stopped reminders for it.
// When: FEE_REMINDER_DAYS after step2_at (1, 4, 10, 21 days), then marked
// closed at FEE_CLOSE_DAYS (28) — a label for the dashboard; paying later
// still works.
// To: the student and every parent/guardian on the application.
//
// Switched on in the dashboard (Fee, interview & text → Reminders). Turning it
// on records the time, and only applications completed AFTER that get
// reminders, so switching on never emails the backlog.
//
// Run by the hourly scheduled function apply-reminders.mjs. A missed run never
// sends a burst: only the most recent due reminder goes, earlier ones are
// recorded as skipped. Each send is claimed in the database first, so two runs
// can't both send it.

import { db } from "./db.mjs";
import { siteUrl } from "./http.mjs";
import * as A from "./applications.mjs";
import { mailOn, sendFeeReminder } from "./notify.mjs";
import { logFamilyEmail } from "./email-log.mjs";
import { FEE_REMINDER_DAYS, FEE_CLOSE_DAYS, emailTemplate } from "../../../public/terms-kit.mjs";

const DAY = 24 * 60 * 60 * 1000;
/** Never two reminders within this gap, whatever the schedule says. */
export const MIN_GAP_MS = 20 * 60 * 60 * 1000;
/** Per run, so a misconfiguration can't flood the mailbox. */
export const MAX_SENDS_PER_RUN = 60;

export function reminderSettings(schema) {
  const r = schema?.settings?.feeReminders || {};
  const since = r.since ? new Date(r.since) : null;
  return { enabled: r.enabled === true && !!since && !Number.isNaN(since.getTime()), since };
}

/**
 * What to do for one application now. Pure (tested).
 *   { action: "send", stage: 1..4, skip: [earlier unsent stages] }
 *   { action: "close" }
 *   { action: "none", reason }
 */
export function reminderAction(app, schema, now = new Date()) {
  const cfg = reminderSettings(schema);
  if (!cfg.enabled) return { action: "none", reason: "off" };
  if (!app.step2_at) return { action: "none", reason: "no full application" };
  if (app.paid_at) return { action: "none", reason: "paid" };
  if (app.status === "withdrawn") return { action: "none", reason: "withdrawn" };
  const r = app.reminders || {};
  if (r.stopped) return { action: "none", reason: "stopped" };
  if (r.closedAt) return { action: "none", reason: "closed" };
  const done = new Date(app.step2_at);
  if (done < cfg.since) return { action: "none", reason: "before reminders were switched on" };
  const age = now - done;
  if (age >= FEE_CLOSE_DAYS * DAY) return { action: "close" };

  const sent = r.sent || {};
  const skipped = new Set((r.skipped || []).map(Number));
  const lastAt = Object.values(sent).map((x) => new Date(x?.at).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (lastAt && now - lastAt < MIN_GAP_MS) return { action: "none", reason: "sent recently" };

  // The latest stage whose day has come.
  let due = 0;
  FEE_REMINDER_DAYS.forEach((d, i) => { if (age >= d * DAY) due = i + 1; });
  if (!due) return { action: "none", reason: "not yet" };
  const latestDone = Math.max(0, ...Object.keys(sent).map(Number), ...skipped);
  if (due <= latestDone) return { action: "none", reason: "up to date" };
  const skip = [];
  for (let st = latestDone + 1; st < due; st++) skip.push(st);
  if (!emailTemplate(schema, `feeReminder${due}`).enabled) return { action: "skip", stage: due, skip };
  return { action: "send", stage: due, skip };
}

/** When an application completed at `step2At` will be closed. */
export function closeDate(step2At) {
  return new Date(new Date(step2At).getTime() + FEE_CLOSE_DAYS * DAY);
}

/** Atomically claims a stage. false when another run got there first. */
async function claim(id, stage, skip) {
  const rows = await db().query(
    `UPDATE applications
        SET reminders = jsonb_set(
              jsonb_set(reminders, '{sent}', COALESCE(reminders->'sent', '{}'::jsonb) || jsonb_build_object($2::text, jsonb_build_object('at', now(), 'pending', true))),
              '{skipped}', COALESCE(reminders->'skipped', '[]'::jsonb) || $3::jsonb),
            updated_at = now()
      WHERE id = $1 AND paid_at IS NULL AND NOT (COALESCE(reminders->'sent', '{}'::jsonb) ? $2::text)
      RETURNING id`,
    [id, String(stage), JSON.stringify(skip)]);
  return rows.length > 0;
}

async function record(id, stage, value) {
  await db().query(
    `UPDATE applications SET reminders = jsonb_set(reminders, ARRAY['sent', $2::text], $3::jsonb) - 'lastError', updated_at = now() WHERE id = $1`,
    [id, String(stage), JSON.stringify(value)]);
}

async function release(id, stage, err) {
  await db().query(
    `UPDATE applications SET reminders = (reminders #- ARRAY['sent', $2::text]) || jsonb_build_object('lastError', jsonb_build_object('at', now(), 'stage', $2::int, 'error', $3::text)), updated_at = now() WHERE id = $1`,
    [id, String(stage), String(err?.message || err).slice(0, 300)]);
}

async function markSkipped(id, stages) {
  await db().query(
    `UPDATE applications SET reminders = jsonb_set(reminders, '{skipped}', COALESCE(reminders->'skipped', '[]'::jsonb) || $2::jsonb), updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(stages)]);
}

async function markClosed(id) {
  await db().query(
    `UPDATE applications SET reminders = reminders || jsonb_build_object('closedAt', now()), updated_at = now() WHERE id = $1 AND paid_at IS NULL`,
    [id]);
}

/** One pass over every unpaid application. Returns a summary. */
export async function runReminders({ schema, now = new Date(), log = console } = {}) {
  const out = { sent: 0, closed: 0, skipped: 0, failed: 0, checked: 0, off: false };
  if (!reminderSettings(schema).enabled) { out.off = true; return out; }
  if (!mailOn()) { out.off = true; out.reason = "SMTP not configured"; return out; }
  const rows = await db().query(
    `SELECT ${A.COLS}, reminders FROM applications
      WHERE paid_at IS NULL AND step2_at IS NOT NULL AND status <> 'withdrawn'
        AND step2_at > now() - interval '${FEE_CLOSE_DAYS + 7} days'
        AND NOT (reminders ? 'stopped') AND NOT (reminders ? 'closedAt')
      ORDER BY step2_at LIMIT 1000`);
  for (const app of rows) {
    out.checked++;
    const act = reminderAction(app, schema, now);
    if (act.action === "close") { await markClosed(app.id); out.closed++; continue; }
    if (act.action === "skip") { await markSkipped(app.id, [...act.skip, act.stage]); out.skipped++; continue; }
    if (act.action !== "send") continue;
    if (out.sent >= MAX_SENDS_PER_RUN) { out.deferred = (out.deferred || 0) + 1; continue; }
    if (!(await claim(app.id, act.stage, act.skip))) continue;
    try {
      const token = await A.addLinkToken(app.id);
      const link = `${siteUrl()}/?token=${encodeURIComponent(token)}`;
      const msg = await sendFeeReminder(app, schema, act.stage, { link, closeDate: closeDate(app.step2_at) });
      await record(app.id, act.stage, { at: new Date().toISOString(), to: msg.to });
      out.sent++;
      // On the HubSpot timelines. The personal link is a login, so it's
      // replaced in the logged copy — anyone with HubSpot access would
      // otherwise be able to open the application.
      const scrub = (x) => String(x || "").split(link).join(`${siteUrl()}/`);
      const lg = await logFamilyEmail(app, { ...msg, text: scrub(msg.text), html: scrub(msg.html.split(link.replace(/&/g, "&amp;")).join(`${siteUrl()}/`)) });
      await record(app.id, act.stage, { at: new Date().toISOString(), to: msg.to, hubspot: lg });
    } catch (err) {
      log.error(`[reminders] ${app.id} stage ${act.stage}:`, err.message);
      await release(app.id, act.stage, err);
      out.failed++;
    }
  }
  return out;
}
