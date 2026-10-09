// Background sync for one quiz response (see _lib/quiz.mjs). Body: { id, force? }.
// Requires the x-apply-key service header.
import { safeEqual } from "./_lib/http.mjs";
import { publishedQuiz, syncQuiz } from "./_lib/quiz.mjs";

export const handler = async (event) => {
  const key = process.env.APPLY_SERVICE_KEY;
  const given = event.headers?.["x-apply-key"] || event.headers?.["X-Apply-Key"];
  if (!key || !safeEqual(given, key)) return { statusCode: 403, body: "Forbidden" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Bad request" }; }
  const { schema } = await publishedQuiz({ fresh: true });
  const result = await syncQuiz(body.id, { schema, force: !!body.force });
  console.log("[quiz-sync]", body.id, JSON.stringify(result));
  return { statusCode: 200, body: "ok" };
};
