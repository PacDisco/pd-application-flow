// Jotform mirror: writes each completed step into the original Jotform form
// (same field IDs), so anything still reading Jotform keeps working while
// JOTFORM_MIRROR is on. Turn the mirror off once the portals read pd-apply
// directly, then archive the two forms.
// Env: JOTFORM_API_KEY, JOTFORM_BASE_URL (optional, e.g. https://eu-api.jotform.com)

function base() {
  return (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
}
function key() {
  const k = process.env.JOTFORM_API_KEY;
  if (!k) throw new Error("JOTFORM_API_KEY is not configured");
  return k;
}

async function post(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v == null ? "" : String(v));
  const res = await fetch(`${base()}${path}?apiKey=${encodeURIComponent(key())}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok || (data && data.responseCode && data.responseCode >= 400)) {
    throw new Error(`Jotform ${path} → ${res.status}: ${(data?.message || text || "").slice(0, 300)}`);
  }
  return data;
}

/** Creates a submission; returns its Jotform submission id. */
export async function createSubmission(formId, params) {
  const data = await post(`/form/${encodeURIComponent(formId)}/submissions`, params);
  const id = data?.content?.submissionID || data?.content?.[0]?.submissionID || data?.content?.id;
  if (!id) throw new Error(`Jotform did not return a submission id: ${JSON.stringify(data).slice(0, 200)}`);
  return String(id);
}

export async function updateSubmission(submissionId, params) {
  return post(`/submission/${encodeURIComponent(submissionId)}`, params);
}
