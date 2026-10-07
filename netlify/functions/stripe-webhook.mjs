// Stripe webhook — marks the application fee paid even if the applicant
// closes the tab before returning from Checkout.
//
// Stripe dashboard → Developers → Webhooks → Add endpoint:
//   URL     https://apply.pacificdiscovery.org/api/stripe-webhook
//   Events  checkout.session.completed, checkout.session.async_payment_succeeded
// Copy the signing secret into STRIPE_WEBHOOK_SECRET.
//
// Sessions that aren't from pd-apply (the student portal uses the same Stripe
// account) are acknowledged and ignored.

import { verifyWebhook } from "./_lib/stripe.mjs";
import { json } from "./_lib/http.mjs";
import { publishedSchema } from "./_lib/db.mjs";
import * as A from "./_lib/applications.mjs";
import { recordPayment } from "./apply.mjs";

export const config = { path: "/api/stripe-webhook" };

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("stripe-signature"))) return json({ error: "Bad signature" }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "Bad JSON" }, 400); }
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return json({ ignored: event.type });
  const session = event.data?.object || {};
  if (session.metadata?.source !== "pd-apply" || !session.client_reference_id) return json({ ignored: "not pd-apply" });
  if (session.payment_status !== "paid") return json({ ignored: "not paid yet" });
  const app = await A.byId(session.client_reference_id);
  if (!app) return json({ ignored: "unknown application" });
  const r = await recordPayment(app.id, session);
  if (r.first) {
    const { schema } = await publishedSchema();
    await A.triggerSync(app.id, { schema });
  }
  return json({ ok: true, first: r.first });
};
