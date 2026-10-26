// Stripe webhook — marks the application fee paid even if the applicant
// closes the tab before returning from Checkout.
//
// Stripe dashboard → Developers → Webhooks → Add endpoint:
//   URL     https://apply.pacificdiscovery.org/api/stripe-webhook
//   Events  checkout.session.completed, checkout.session.async_payment_succeeded,
//           checkout.session.async_payment_failed (bank payments that bounce),
//           payment_intent.succeeded, payment_intent.payment_failed
//           (automatic instalments — bank ones settle days later)
// Copy the signing secret into STRIPE_WEBHOOK_SECRET.
//
// Sessions that aren't from pd-apply (the student portal uses the same Stripe
// account) are acknowledged and ignored.

import { verifyWebhook } from "./_lib/stripe.mjs";
import { json } from "./_lib/http.mjs";
import { publishedSchema } from "./_lib/db.mjs";
import * as A from "./_lib/applications.mjs";
import { recordPayment } from "./apply.mjs";
import * as E from "./_lib/enrol.mjs";
import * as PAY from "./_lib/payments.mjs";

export const config = { path: "/api/stripe-webhook" };

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("stripe-signature"))) return json({ error: "Bad signature" }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "Bad JSON" }, 400); }
  // Automatic instalments (no Checkout session).
  if (["payment_intent.succeeded", "payment_intent.payment_failed"].includes(event.type)) {
    const pi = event.data?.object || {};
    if (pi.metadata?.source !== "pd-apply" || pi.metadata?.payment_kind !== "instalment") return json({ ignored: "not an instalment" });
    const { schema } = await publishedSchema();
    return json({ ok: true, ...(await PAY.paymentIntentEvent(event.type, pi, schema)) });
  }
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"].includes(event.type)) return json({ ignored: event.type });
  const session = event.data?.object || {};
  if (session.metadata?.source !== "pd-apply" || !session.client_reference_id) return json({ ignored: "not pd-apply" });
  // Deposit / tuition from the acceptance page (stage 4).
  // Paying a balance / failed instalment from the acceptance page, or saving a new card / bank account.
  if (session.metadata?.payment_kind === "item" || session.metadata?.payment_kind === "setup") {
    const { schema } = await publishedSchema();
    if (session.metadata.payment_kind === "setup") return json({ ok: true, ...(await PAY.recordSetup(session, schema)) });
    if (event.type === "checkout.session.async_payment_failed") return json({ ok: true, ...(await PAY.itemCheckoutFailed(session, schema)) });
    return json({ ok: true, ...(await PAY.recordItemCheckout(session, schema)) });
  }
  if (session.metadata?.payment_kind === "deposit") {
    const { schema } = await publishedSchema();
    if (event.type === "checkout.session.async_payment_failed") {
      await E.depositFailed(session, schema);
      return json({ ok: true, failed: true });
    }
    const r = await E.recordDeposit(session, schema);
    return json({ ok: true, first: !!r.first });
  }
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
