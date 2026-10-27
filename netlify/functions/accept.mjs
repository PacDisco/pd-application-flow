// The acceptance page's API (public, token = the personal link from the
// acceptance email).
//
//   GET  /api/accept/offer?token=&session_id=   what the page shows (and, on
//                                               return from Stripe, records it)
//   POST /api/accept/checkout { token, plan, method, agree }  → { url }
//   POST /api/accept/pay-item { token, index, method }        → { url }  (balance / failed payment)
//   POST /api/accept/update-method { token }                  → { url }  (new card / bank account)
import { json, readJson, errorResponse } from "./_lib/http.mjs";
import { publishedSchema } from "./_lib/db.mjs";
import * as A from "./_lib/applications.mjs";
import * as E from "./_lib/enrol.mjs";
import * as PAY from "./_lib/payments.mjs";
import { dealPaid } from "./_lib/deal-paid.mjs";
import { publishedTermsOrNull } from "./_lib/terms.mjs";

export const config = { path: "/api/accept/*" };

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/accept\/?/, "").replace(/\/+$/, "");
  try {
    const { schema } = await publishedSchema();
    if (req.method === "GET" && route === "offer") {
      const app = await A.byToken(url.searchParams.get("token"));
      if (!app) throw bad("We couldn't find your acceptance. Please use the link in your email, or contact admissions.", 404);
      const sid = url.searchParams.get("session_id");
      if (sid) { await E.confirmReturn(app, sid, schema); await PAY.confirmReturn(app, sid, schema); }
      const { enrolment, decision } = await E.readEnrolment(app.id);
      const terms = await publishedTermsOrNull();
      const dealTotal = (await dealPaid(app))?.total ?? null;
      return json({ offer: E.offerView(app, { enrolment, decision, dealTotal }, schema, terms) });
    }
    if (req.method === "POST" && route === "checkout") {
      const body = await readJson(req);
      const app = await A.byToken(body.token);
      if (!app) throw bad("We couldn't find your acceptance.", 404);
      const out = await E.startCheckout(app, { plan: body.plan, method: body.method, agree: body.agree === true, token: body.token }, schema);
      return json(out);
    }
    if (req.method === "POST" && (route === "pay-item" || route === "update-method")) {
      const body = await readJson(req);
      const app = await A.byToken(body.token);
      if (!app) throw bad("We couldn't find your application.", 404);
      if (route === "pay-item") return json(await PAY.startItemCheckout(app, { index: body.index, method: body.method, token: body.token }, schema));
      return json(await PAY.startSetup(app, { token: body.token }));
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return errorResponse(err, `accept:${route}`);
  }
};
