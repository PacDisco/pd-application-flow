// What the HubSpot deal says has been paid (payment_1..10 / total_amount_paid).
// The deal is the record of every payment however it arrived — Stripe via
// pd-apply, the student portal, bank transfers logged by admissions — so it's
// what tells us whether the application fee and/or deposit are already paid.
// Parsing is shared with the student portal (deal-payments.mjs).
import * as HS from "./hubspot.mjs";
import { hubspotOn } from "./email-log.mjs";
import { totalPaidForDeal, parseDealPayments } from "./deal-payments.mjs";

const TTL_MS = 60 * 1000;
const cache = new Map();

/** { total, entries } from the deal, or null (no deal / HubSpot off / unreachable). Never throws. */
export async function dealPaid(app, { fresh = false } = {}) {
  const id = app?.hubspot_deal_id;
  if (!id || !hubspotOn()) return null;
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const deal = await HS.getDeal(id);
    const props = deal?.properties || {};
    const entries = parseDealPayments(props);
    const { totalPaid } = totalPaidForDeal(props, entries);
    const value = { total: totalPaid, entries: entries.map((e) => ({ index: e.index, amount: e.amount, reference: e.reference, date: e.dateIso })) };
    cache.set(id, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn("[deal-paid]", id, err.message);
    return hit?.value || null;
  }
}

export function __clearDealPaidCache() { cache.clear(); }
