// Stripe, without the SDK (same approach as the student portal's
// create-checkout-session.js). Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
import crypto from "node:crypto";

function secret() {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error("STRIPE_SECRET_KEY is not configured");
  return k;
}

async function stripe(path, { method = "GET", params } = {}) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret()}`, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? params.toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe ${path} → ${res.status}`);
    err.status = 502;
    throw err;
  }
  return data;
}

async function customerFor(email, name) {
  const found = await stripe(`/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (found?.data?.[0]?.id) return found.data[0].id;
  const p = new URLSearchParams();
  p.append("email", email);
  if (name) p.append("name", name);
  p.append("metadata[source]", "pd-apply");
  return (await stripe("/customers", { method: "POST", params: p })).id;
}

/**
 * Checkout for the application fee. Two line items so the receipt shows the
 * card fee separately: Application fee $250 + Card processing fee (3.5%).
 */
export async function createAppFeeCheckout({ app, fee, currency, successUrl, cancelUrl, dealId }) {
  const customer = await customerFor(app.email, [app.first_name, app.last_name].filter(Boolean).join(" "));
  const p = new URLSearchParams();
  p.append("mode", "payment");
  p.append("payment_method_types[]", "card");
  p.append("customer", customer);
  p.append("customer_update[name]", "auto");
  p.append("customer_update[address]", "auto");
  p.append("client_reference_id", app.id);
  const items = [
    [`Application Fee — ${app.program || "Pacific Discovery"}`, fee.base],
    [`Card processing fee (${(fee.rate * 100).toFixed(1).replace(/\.0$/, "")}%)`, fee.surcharge],
  ];
  items.forEach(([name, amount], i) => {
    p.append(`line_items[${i}][quantity]`, "1");
    p.append(`line_items[${i}][price_data][currency]`, currency);
    p.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(amount * 100)));
    p.append(`line_items[${i}][price_data][product_data][name]`, name);
  });
  p.append("success_url", successUrl);
  p.append("cancel_url", cancelUrl);
  const meta = {
    application_id: app.id,
    contact_email: app.email,
    payment_type: "card",
    payment_kind: "application_fee",
    base_amount: String(fee.base),
    charge_amount: String(fee.total),
    processing_fee_rate: String(fee.rate),
    program: String(app.program || "").slice(0, 400),
    travel_term: String(app.term || ""),
    source: "pd-apply",
    ...(dealId ? { deal_id: String(dealId) } : {}),
  };
  for (const [k, v] of Object.entries(meta)) {
    p.append(`metadata[${k}]`, v);
    p.append(`payment_intent_data[metadata][${k}]`, v);
  }
  p.append("payment_intent_data[description]", `Application fee — ${app.first_name || ""} ${app.last_name || ""}`.trim());
  return stripe("/checkout/sessions", { method: "POST", params: p });
}

export async function getCheckoutSession(id) {
  return stripe(`/checkout/sessions/${encodeURIComponent(id)}`);
}

/** Verifies a Stripe-Signature header (v1 scheme, 5 minute tolerance). */
export function verifyWebhook(rawBody, header, whsec = process.env.STRIPE_WEBHOOK_SECRET, now = Date.now()) {
  if (!whsec || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map((kv) => kv.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(",").filter((s) => s.trim().startsWith("v1=")).map((s) => s.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac("sha256", whsec).update(`${t}.${rawBody}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
