// The acceptance page's API (public, token = the personal link from the
// acceptance email).
//
//   GET  /api/accept/offer?token=&session_id=   what the page shows (and, on
//                                               return from Stripe, records it)
//   POST /api/accept/checkout { token, plan, method, agree }  → { url }
import { json, readJson, errorResponse } from "./_lib/http.mjs";
import { publishedSchema } from "./_lib/db.mjs";
import * as A from "./_lib/applications.mjs";
import * as E from "./_lib/enrol.mjs";
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
      if (sid) await E.confirmReturn(app, sid, schema);
      const { enrolment, decision } = await E.readEnrolment(app.id);
      const terms = await publishedTermsOrNull();
      return json({ offer: E.offerView(app, { enrolment, decision }, schema, terms) });
    }
    if (req.method === "POST" && route === "checkout") {
      const body = await readJson(req);
      const app = await A.byToken(body.token);
      if (!app) throw bad("We couldn't find your acceptance.", 404);
      const out = await E.startCheckout(app, { plan: body.plan, method: body.method, agree: body.agree === true, token: body.token }, schema);
      return json(out);
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return errorResponse(err, `accept:${route}`);
  }
};
