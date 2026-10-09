// Public API for the gap-year quiz (apply.pacificdiscovery.org/quiz).
//
//   GET  /api/quiz/schema                        the published quiz
//   POST /api/quiz/submit { values, hp, attribution } → { id, archetype, result }
//   POST /api/quiz/resync { id, force }          (service key) re-send to HubSpot
//
// Scoring happens here (quiz-kit.mjs); the browser only shows the result.

import { db } from "./_lib/db.mjs";
import { json, readJson, errorResponse, serviceOk } from "./_lib/http.mjs";
import * as K from "../../public/form-kit.mjs";
import * as Q from "../../public/quiz-kit.mjs";
import { sanitizeAttribution } from "../../public/attribution-kit.mjs";
import { publishedQuiz, createResponse, triggerQuizSync, syncQuiz } from "./_lib/quiz.mjs";

export const config = { path: "/api/quiz/*" };

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/quiz\/?/, "").replace(/\/+$/, "");
  try {
    if (req.method === "GET" && route === "schema") {
      const { schema, rev } = await publishedQuiz();
      return json({ rev, schema: Q.publicQuiz(schema) }, 200, { "Cache-Control": "public, max-age=30" });
    }
    if (req.method === "POST" && route === "submit") return await submit(req, context);
    if (req.method === "POST" && route === "resync") {
      if (!serviceOk(req)) return json({ error: "Forbidden" }, 403);
      const b = await readJson(req);
      return json({ result: await syncQuiz(b.id, { force: b.force !== false }) });
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return errorResponse(err, `quiz:${route}`);
  }
};

async function submit(req, context) {
  const body = await readJson(req);
  if (body.hp) return json({ error: "Please try again." }, 400);
  const { schema, rev } = await publishedQuiz();
  const values = body.values && typeof body.values === "object" ? body.values : {};
  const a = K.validateStep(schema, "quiz", values);
  const b = K.validateStep(schema, "contact", values);
  if (!a.ok || !b.ok) return json({ error: "Please answer every question.", errors: { ...a.errors, ...b.errors } }, 422);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || null;
  if (ip) {
    const rows = await db()`SELECT count(*)::int AS n FROM quiz_responses WHERE ip = ${ip} AND created_at > now() - interval '1 hour'`;
    if ((rows[0]?.n || 0) >= 20) return json({ error: "Too many quizzes from this connection. Please try again later." }, 429);
  }
  const clean = { ...a.clean, ...b.clean };
  const scored = Q.scoreQuiz(schema, clean);
  const row = await createResponse({ schema, rev, clean, scored, attribution: sanitizeAttribution(body.attribution), ip, userAgent: req.headers.get("user-agent") });
  await triggerQuizSync(row.id, { schema });
  const result = Q.archetypeByKey(schema, scored.archetype);
  return json({ id: row.id, archetype: scored.archetype, result, ranked: schema.settings?.showScores ? scored.ranked : undefined });
}
