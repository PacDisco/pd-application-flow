// Program / season switches made in HubSpot → the application follows.
//
// Admissions records a switch on the student's existing deal: the pipeline
// (season + program type), PD Program and Travel Year. Every hour (and when
// admissions clicks "Refresh from HubSpot") the deals of open applications are
// read back; when they no longer match the application, the application's
// program / term are updated, the student, parents and deal are moved to the
// new Pacific Discovery program record, and an accepted offer takes the new
// start date. The price follows the deal's Amount separately (enrol / payments).

import { db } from "./db.mjs";
import * as A from "./applications.mjs";
import * as HS from "./hubspot.mjs";
import * as R from "./routing.mjs";
import * as K from "../../../public/form-kit.mjs";
import * as P from "../../../public/plans-kit.mjs";
import { dealFacts } from "./import.mjs";
import { programDates, patchEnrolment, readEnrolment } from "./enrol.mjs";
import { alertOn, sendAdmissionsAlert } from "./notify.mjs";
import { hubspotOn } from "./email-log.mjs";

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The dashboard program a deal's PD Program value stands for (or the value itself). */
export function programForPd(schema, pdOptions, pdValue) {
  if (!pdValue) return null;
  const hit = (schema?.programs || []).find((p) => norm(p.name) === norm(pdValue) || norm(p.pdProgram) === norm(pdValue)
    || R.matchPdProgram(pdOptions, p.name, p.pdProgram) === pdValue);
  if (hit) return { name: hit.name, type: hit.type || null };
  const opt = (pdOptions || []).find((o) => o.value === pdValue);
  return { name: String(opt?.label || pdValue), type: null };
}

/**
 * What the deal says the application should be, if that differs. Pure (tested).
 * Only what the deal states is used: the application pipeline has no season,
 * so the season is kept; an empty PD Program keeps the program.
 * → null | { program, programType, season, year, term, changes: [{ field, from, to }] }
 */
export function dealChange(app, deal, pipeline, { schema, pdOptions = [] } = {}) {
  if (!deal?.properties) return null;
  const f = dealFacts(deal, pipeline);
  // Compare in HubSpot's terms: the PD Program the application's program maps to vs the deal's.
  const pdNow = deal.properties.pd_program || "";
  const cur = K.programByName(schema, app.program);
  const pdApp = R.matchPdProgram(pdOptions, app.program || "", cur?.pdProgram || "");
  const switched = pdNow && norm(pdNow) !== norm(pdApp) && norm(pdNow) !== norm(app.program);
  const p = switched ? programForPd(schema, pdOptions, pdNow) : null;
  const program = p?.name || app.program;
  const season = f.season || app.season;
  const year = f.year || (app.travel_year ? String(app.travel_year) : null);
  const term = season && year ? `${season} ${year}` : app.term;
  const programType = f.programType || p?.type || K.programByName(schema, program)?.type || app.program_type || null;
  const changes = [];
  if (norm(program) !== norm(app.program)) changes.push({ field: "program", from: app.program || "", to: program });
  if (norm(term) !== norm(app.term)) changes.push({ field: "term", from: app.term || "", to: term });
  if (!changes.length) return null;
  return { program, programType, season, year, term, changes };
}

/** Apply a switch to one application. */
export async function applyProgramChange(app, ch, schema, { now = new Date(), log = console } = {}) {
  const at = now.toISOString();
  const entry = { at, changes: ch.changes, by: "HubSpot deal" };
  const rows = await db().query(
    `UPDATE applications
        SET program = $2, term = $3, season = $4, travel_year = $5, program_type = $6,
            answers = COALESCE(answers, '{}'::jsonb) || jsonb_build_object('program', $2::text, 'term', $3::text),
            sync = (COALESCE(sync, '{}'::jsonb) - 'hsProgramError' - 'hsProgram') || jsonb_build_object('programChanges', COALESCE(sync->'programChanges', '[]'::jsonb) || $7::jsonb),
            updated_at = now()
      WHERE id = $1 AND program IS NOT DISTINCT FROM $8 AND term IS NOT DISTINCT FROM $9
      RETURNING id`,
    [app.id, ch.program, ch.term, ch.season, ch.year, ch.programType, JSON.stringify([entry]), app.program, app.term]);
  if (!rows.length) return { skipped: "changed meanwhile" };
  const fresh = await A.byId(app.id);
  const out = { id: app.id, changes: ch.changes };

  // Program record: link to the new one, unlink the old (the portals use these links).
  const old = app.sync?.hsProgram;
  if (fresh.paid_at && hubspotOn()) {
    try {
      const r = await A.linkFamilyAndProgram(fresh, schema, { family: false, program: true });
      if (r.program?.record) {
        await A.setSyncPatch(app.id, { hsProgram: { ok: true, at, ...r.program } });
        if (old?.record?.id && String(old.record.id) !== String(r.program.record.id)) {
          const OBJ = R.PROGRAM_OBJECT_TYPE;
          for (const l of old.links || []) if (l.contactId) await HS.unassociate("contacts", l.contactId, OBJ, old.record.id).catch((e) => log.error?.("[deal-sync unlink]", e.message));
          if (app.hubspot_deal_id) await HS.unassociate("deals", app.hubspot_deal_id, OBJ, old.record.id).catch((e) => log.error?.("[deal-sync unlink]", e.message));
        }
        out.programRecord = r.program.record.id;
      } else {
        await A.setSyncPatch(app.id, { hsProgram: undefined, hsProgramError: { ok: false, at, error: r.program?.reason || "no matching program record", candidates: r.program?.candidates } });
        out.programRecord = null;
      }
    } catch (err) { log.error?.("[deal-sync program]", err.message); out.programError = err.message; }
  }

  // Accepted: the offer takes the new departure's dates.
  const { enrolment: e, decision: d } = await readEnrolment(app.id);
  const problems = [];
  if (d?.outcome === "accepted" && e.offer && !e.withdrawn) {
    let dates = { start: null, end: null, recordId: null };
    try { dates = await programDates(await A.byId(app.id)); } catch (err) { log.error?.("[deal-sync dates]", err.message); }
    if (dates.start) {
      await patchEnrolment(app.id, { offer: { ...e.offer, start: dates.start, end: dates.end, programRecordId: dates.recordId, programChangedAt: at } });
      out.start = dates.start;
      const deposited = ["paid", "processing"].includes(e.deposit?.status);
      if (deposited) {
        // The plan was built for the old start date: payments now due too late need a look.
        const planEnd = P.iso(new Date(P.day(dates.start).getTime() - P.PLAN_END_DAYS * 864e5));
        const late = (e.schedule || []).filter((p, i) => i > 0 && ["scheduled", "failed", "needs_admissions", "due"].includes(p.status) && p.due > planEnd);
        if (late.length) problems.push(`${late.length} remaining payment${late.length === 1 ? " is" : "s are"} now due less than ${P.PLAN_END_DAYS} days before the new start (${dates.start}). Mark them paid, or ask the family to pay early from their acceptance link.`);
      }
    } else {
      problems.push(`No start date found for ${ch.program} ${ch.term} — the HubSpot program record needs a Program Start Date. The offer still shows the old dates (${e.offer.start || "?"}).`);
    }
  }

  const summary = ch.changes.map((c) => `${c.field} ${c.from || "—"} → ${c.to}`).join("; ");
  if (hubspotOn() && (app.hubspot_contact_id || app.hubspot_deal_id)) {
    try { await HS.addNote(`<p><strong>Application updated from the deal</strong> — ${esc(summary)}.${out.start ? ` New start date ${esc(out.start)}.` : ""}${problems.length ? ` ⚠️ ${esc(problems.join(" "))}` : ""}</p>`, { contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id }); }
    catch (err) { log.error?.("[deal-sync note]", err.message); }
  }
  if (problems.length && alertOn()) {
    try { await sendAdmissionsAlert(fresh, "Program switch needs a look", [`The application was updated from the HubSpot deal: ${summary}.`, ...problems]); }
    catch (err) { log.error?.("[deal-sync alert]", err.message); }
  }
  if (problems.length) out.problems = problems;
  return out;
}

/** Hourly: read the deals of open applications and apply any switches. */
export async function syncFromDeals({ schema, ids = null, now = new Date(), log = console } = {}) {
  if (!hubspotOn()) return { skipped: "HubSpot off" };
  const apps = await db().query(
    `SELECT ${A.COLS} FROM applications
      WHERE hubspot_deal_id IS NOT NULL AND status <> 'withdrawn'
        AND COALESCE((decision->>'outcome'), '') <> 'declined'
        AND COALESCE((enrolment->'withdrawn') IS NULL, true)
        ${ids ? "AND id = ANY($1::uuid[])" : "AND created_at > now() - interval '2 years'"}`,
    ids ? [ids] : []);
  const out = { checked: apps.length, changed: [] };
  if (!apps.length) return out;
  const [pipes, pdOptions] = await Promise.all([HS.dealPipelines(), HS.propertyOptions("deals", "pd_program").catch(() => [])]);
  const deals = new Map();
  for (let i = 0; i < apps.length; i += 100) {
    for (const d of await HS.getDeals(apps.slice(i, i + 100).map((a) => a.hubspot_deal_id))) deals.set(String(d.id), d);
  }
  for (const app of apps) {
    const deal = deals.get(String(app.hubspot_deal_id));
    if (!deal) continue;
    const pipe = pipes.find((p) => p.id === String(deal.properties?.pipeline));
    const ch = dealChange(app, deal, pipe, { schema, pdOptions });
    if (!ch) continue;
    try { out.changed.push(await applyProgramChange(app, ch, schema, { now, log })); }
    catch (err) { log.error?.("[deal-sync]", app.id, err.message); out.changed.push({ id: app.id, error: err.message }); }
  }
  return out;
}
