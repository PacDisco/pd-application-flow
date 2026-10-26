// Stripe, without the SDK (same approach as the student portal's
// create-checkout-session.js). Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
import crypto from "node:crypto";

function secret() {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error("STRIPE_SECRET_KEY is not configured");
  return k;
}

async function stripe(path, { method = "GET", params, idempotencyKey } = {}) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret()}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params ? params.toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe ${path} → ${res.status}`);
    err.status = 502;
    err.stripe = data?.error || null; // code, decline_code, payment_intent (off-session declines)
    throw err;
  }
  return data;
}

export async function customerFor(email, name) {
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
export async function createAppFeeCheckout({ app, fee, currency, successUrl, cancelUrl, dealId, policy = "", termsVersion = null }) {
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
  // Shown above the Pay button on Stripe's page (Stripe caps it at 1200 chars).
  if (policy) p.append("custom_text[submit][message]", String(policy).slice(0, 1200));
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
    ...(termsVersion ? { terms_version: String(termsVersion) } : {}),
  };
  for (const [k, v] of Object.entries(meta)) {
    p.append(`metadata[${k}]`, v);
    p.append(`payment_intent_data[metadata][${k}]`, v);
  }
  p.append("payment_intent_data[description]", `Application fee — ${app.first_name || ""} ${app.last_name || ""}`.trim());
  return stripe("/checkout/sessions", { method: "POST", params: p });
}

/**
 * Refund a payment in full (or `amount` dollars). The idempotency key makes a
 * double click, or a retry after a timeout, refund only once.
 */
export async function refundPayment(paymentIntent, { amount = null, key, reason = "requested_by_customer", metadata = {} } = {}) {
  if (!/^pi_/.test(String(paymentIntent || ""))) throw Object.assign(new Error("No Stripe payment to refund for this application."), { status: 409 });
  const p = new URLSearchParams();
  p.append("payment_intent", paymentIntent);
  if (amount != null) p.append("amount", String(Math.round(Number(amount) * 100)));
  p.append("reason", reason);
  for (const [k, v] of Object.entries(metadata)) p.append(`metadata[${k}]`, String(v));
  return stripe("/refunds", { method: "POST", params: p, idempotencyKey: key });
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

/** Stripe payment_method_types for a method choice. ACH = US bank account. */
export function methodTypes(method) {
  if (method === "ach") return (process.env.STRIPE_DIRECT_DEBIT_METHODS || "us_bank_account").split(",").map((x) => x.trim()).filter(Boolean);
  return ["card"];
}

/**
 * Checkout for the deposit (and, depending on the plan, the first instalment
 * or the whole balance). `save` keeps the card / bank account on the Stripe
 * customer for the automatic instalments.
 */
export async function createDepositCheckout({ app, lines, currency, method, save, successUrl, cancelUrl, metadata, description, expiresAt }) {
  const customer = await customerFor(app.email, [app.first_name, app.last_name].filter(Boolean).join(" "));
  const p = new URLSearchParams();
  p.append("mode", "payment");
  for (const t of methodTypes(method)) p.append("payment_method_types[]", t);
  p.append("customer", customer);
  p.append("customer_update[name]", "auto");
  p.append("customer_update[address]", "auto");
  p.append("client_reference_id", app.id);
  lines.filter(([, amount]) => amount > 0).forEach(([name, amount], i) => {
    p.append(`line_items[${i}][quantity]`, "1");
    p.append(`line_items[${i}][price_data][currency]`, currency);
    p.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(amount * 100)));
    p.append(`line_items[${i}][price_data][product_data][name]`, name);
  });
  if (save) p.append("payment_intent_data[setup_future_usage]", "off_session");
  if (method === "ach") p.append("payment_method_options[us_bank_account][verification_method]", "automatic");
  if (expiresAt) p.append("expires_at", String(expiresAt));
  p.append("success_url", successUrl);
  p.append("cancel_url", cancelUrl);
  const meta = { source: "pd-apply", application_id: app.id, contact_email: app.email, ...metadata };
  for (const [k, v] of Object.entries(meta)) {
    p.append(`metadata[${k}]`, String(v ?? "").slice(0, 500));
    p.append(`payment_intent_data[metadata][${k}]`, String(v ?? "").slice(0, 500));
  }
  if (description) p.append("payment_intent_data[description]", description.slice(0, 300));
  return stripe("/checkout/sessions", { method: "POST", params: p });
}

export async function getPaymentIntent(id) {
  return stripe(`/payment_intents/${encodeURIComponent(id)}`);
}

/**
 * Charge a saved card / bank account without the customer present (an
 * instalment). Never throws for a decline: returns the PaymentIntent, or
 * { status: "failed", error } with Stripe's reason. The idempotency key makes a
 * retried run return the same attempt instead of charging twice.
 */
export async function chargeSaved({ customer, paymentMethod, amount, currency, method, description, metadata, idempotencyKey }) {
  const p = new URLSearchParams();
  p.append("amount", String(Math.round(Number(amount) * 100)));
  p.append("currency", currency);
  p.append("customer", customer);
  p.append("payment_method", paymentMethod);
  for (const t of methodTypes(method)) p.append("payment_method_types[]", t);
  p.append("off_session", "true");
  p.append("confirm", "true");
  if (description) p.append("description", description.slice(0, 300));
  for (const [k, v] of Object.entries(metadata || {})) p.append(`metadata[${k}]`, String(v ?? "").slice(0, 500));
  try {
    return await stripe("/payment_intents", { method: "POST", params: p, idempotencyKey });
  } catch (err) {
    if (!err.stripe) throw err; // network / config: the run retries this item later
    const e = err.stripe;
    return { id: e.payment_intent?.id || null, status: "failed", error: e.decline_code || e.code || "declined", message: e.message || err.message };
  }
}

/** Checkout in setup mode: save a new card / bank account for the instalments. */
export async function createSetupCheckout({ app, customer, successUrl, cancelUrl, metadata }) {
  const p = new URLSearchParams();
  p.append("mode", "setup");
  p.append("currency", "usd");
  for (const t of [...methodTypes("card"), ...methodTypes("ach")]) p.append("payment_method_types[]", t);
  p.append("customer", customer || await customerFor(app.email, [app.first_name, app.last_name].filter(Boolean).join(" ")));
  p.append("client_reference_id", app.id);
  p.append("success_url", successUrl);
  p.append("cancel_url", cancelUrl);
  const meta = { source: "pd-apply", application_id: app.id, ...metadata };
  for (const [k, v] of Object.entries(meta)) {
    p.append(`metadata[${k}]`, String(v ?? "").slice(0, 500));
    p.append(`setup_intent_data[metadata][${k}]`, String(v ?? "").slice(0, 500));
  }
  return stripe("/checkout/sessions", { method: "POST", params: p });
}

export async function getSetupIntent(id) {
  return stripe(`/setup_intents/${encodeURIComponent(id)}?expand[]=payment_method`);
}

/**
 * Expire an unfinished Checkout session (they started paying, then started
 * again). Returns true if it's now closed without payment; false if it was
 * already completed (paid / clearing) — then don't start another.
 */
export async function expireCheckout(id) {
  try { await stripe(`/checkout/sessions/${encodeURIComponent(id)}/expire`, { method: "POST", params: new URLSearchParams() }); return true; }
  catch (err) {
    const s = await stripe(`/checkout/sessions/${encodeURIComponent(id)}`).catch(() => null);
    return !s || s.status === "expired";
  }
}
