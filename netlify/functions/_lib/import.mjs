// Applicants who applied before pd-apply (Jotform era) have a HubSpot contact
// and deal but no application here, so they can't be accepted from the
// dashboard. Admissions adds them from HubSpot (Applications → Add from
// HubSpot): this creates an application from the deal — program, term, price,
// payments and parents — ready to Accept. Nothing is sent to the family and
// nothing is written to HubSpot or Jotform by the import itself.

import { db } from "./db.mjs";
import { hashToken, newToken } from "./http.mjs";
import * as HS from "./hubspot.mjs";
import { totalPaidForDeal, parseDealPayments } from "./deal-payments.mjs";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const SEASONS = ["Spring", "Summer", "Fall"];

/** Program type, season and term from the deal's pipeline + travel year. Pure (tested). */
export function dealFacts(deal, pipeline) {
  const p = deal?.properties || {};
  const label = String(pipeline?.label || "");
  const season = SEASONS.find((s) => new RegExp(s, "i").test(label)) || null;
  const programType = /mini/i.test(label) ? "mini" : /summer/i.test(label) ? "summer" : season ? "semester" : null;
  const year = String(p.travel_year || "").match(/\d{4}/)?.[0] || null;
  const program = String(p.pd_program || "").trim()
    || String(p.dealname || "").replace(/^.*?\s[-–]\s/, "").trim() || null;
  return { program, programType, season, year, term: season && year ? `${season} ${year}` : null };
}

async function dealContacts(dealId) {
  const assoc = await HS.hs(`/crm/v4/objects/deals/${dealId}/associations/contacts?limit=50`);
  const ids = (assoc?.results || []).map((r) => String(r.toObjectId));
  if (!ids.length) return [];
  const data = await HS.hs("/crm/v3/objects/contacts/batch/read", { method: "POST", body: { properties: ["email", "firstname", "lastname"], inputs: ids.map((id) => ({ id })) } });
  return (data?.results || []).map((c) => ({ id: String(c.id), email: String(c.properties?.email || "").toLowerCase(), first: c.properties?.firstname || "", last: c.properties?.lastname || "" })).filter((c) => c.email);
}

/** The student's HubSpot deals, for admissions to pick one. */
export async function lookup(email) {
  const em = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw bad("Enter the student's email address.");
  const contact = await HS.findContactByEmail(em);
  if (!contact) return { contact: null, deals: [] };
  const [deals, pipes] = await Promise.all([HS.contactDeals(contact.id), HS.dealPipelines()]);
  const existing = deals.length
    ? (await db().query(`SELECT id, hubspot_deal_id FROM applications WHERE hubspot_deal_id = ANY($1::text[])`, [deals.map((d) => String(d.id))]))
    : [];
  const out = deals.map((d) => {
    const pipe = pipes.find((p) => p.id === String(d.properties?.pipeline));
    const stage = pipe?.stages?.find((s) => String(s.id) === String(d.properties?.dealstage));
    const facts = dealFacts(d, pipe);
    return {
      id: String(d.id), name: d.properties?.dealname || "", pipeline: pipe?.label || "", stage: stage?.label || "",
      amount: Number(d.properties?.amount) || null, paid: totalPaidForDeal(d.properties || {}).totalPaid,
      program: facts.program, term: facts.term,
      applicationId: existing.find((x) => String(x.hubspot_deal_id) === String(d.id))?.id || null,
    };
  });
  return { contact: { id: String(contact.id), email: em, first: contact.properties?.firstname || "", last: contact.properties?.lastname || "" }, deals: out };
}

/** Create the application from a deal. Returns { id }. */
export async function importFromDeal({ email, dealId, by = "admissions" }) {
  const em = String(email || "").trim().toLowerCase();
  const did = String(dealId || "");
  if (!em || !did) throw bad("Email and deal are required.");
  const already = await db().query(`SELECT id FROM applications WHERE hubspot_deal_id = $1`, [did]);
  if (already.length) throw bad("This deal already has an application in the dashboard.", 409);
  const contact = await HS.findContactByEmail(em);
  if (!contact) throw bad("No HubSpot contact with that email.", 404);
  const [deal, pipes, people] = await Promise.all([HS.getDeal(did), HS.dealPipelines(), dealContacts(did)]);
  if (!deal?.id) throw bad("Deal not found in HubSpot.", 404);
  if (!people.some((p) => p.id === String(contact.id))) throw bad("That deal isn't linked to this student in HubSpot.", 409);
  const pipe = pipes.find((p) => p.id === String(deal.properties?.pipeline));
  const stage = pipe?.stages?.find((s) => String(s.id) === String(deal.properties?.dealstage));
  const f = dealFacts(deal, pipe);
  if (!f.program || !f.term) throw bad(`Couldn't tell the program and term from this deal (pipeline "${pipe?.label || "?"}", PD Program "${deal.properties?.pd_program || ""}", travel year "${deal.properties?.travel_year || ""}"). Fill those in on the deal first.`, 409);
  const paid = totalPaidForDeal(deal.properties || {}, parseDealPayments(deal.properties || {})).totalPaid;
  const parents = people.filter((p) => p.id !== String(contact.id)).slice(0, 2);
  const first = contact.properties?.firstname || "";
  const last = contact.properties?.lastname || "";
  const answers = {
    name: { first, last }, preferredName: first, email: em,
    ...Object.fromEntries(parents.flatMap((p, i) => [[`parent${i + 1}Email`, p.email], [`parent${i + 1}Name`, { first: p.first, last: p.last }]])),
  };
  const when = deal.properties?.createdate || new Date().toISOString();
  const interviewed = /interview/i.test(stage?.label || "");
  const at = new Date().toISOString();
  const rows = await db().query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, season, travel_year, program_type, deal_amount, status,
        answers, step1_at, step2_at, interview_at, interview, paid_at, payment, hubspot_contact_id, hubspot_deal_id, sync, attribution, reminders)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [hashToken(newToken()), em, first, last, f.program, f.term, f.season, f.year, f.programType, Number(deal.properties?.amount) || null,
      paid >= 250 ? "paid" : interviewed ? "interview" : "step2",
      JSON.stringify(answers), when, interviewed ? when : null, interviewed ? JSON.stringify({ source: "hubspot", label: stage.label }) : null,
      paid >= 250 ? when : null, paid >= 250 ? JSON.stringify({ base: 250, reference: "on the HubSpot deal", imported: true }) : null,
      String(contact.id), did,
      JSON.stringify({ imported: { ok: true, at, by: String(by).slice(0, 120), from: "HubSpot", stage: stage?.label || null, pipeline: pipe?.label || null } }),
      JSON.stringify({ source: "hubspot-import" }),
      JSON.stringify({ stopped: { at, by: "imported from HubSpot" } })]);
  return { id: rows[0].id, program: f.program, term: f.term, paid, parents: parents.map((p) => p.email) };
}
