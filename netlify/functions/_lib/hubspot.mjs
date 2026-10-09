// Minimal HubSpot client for the application flow.
// Env: HUBSPOT_TOKEN (private app; needs crm.objects.contacts.read/write,
//      crm.objects.deals.read/write, crm.schemas.deals.read).
//
// Property writes are resilient: if HubSpot rejects a property (renamed,
// deleted, wrong enumeration value) the call is retried WITHOUT it and the
// dropped names are reported, so one bad mapping in the dashboard never
// blocks a contact or deal from being created.

const BASE = "https://api.hubapi.com";

function token() {
  const t = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!t) throw new Error("HUBSPOT_TOKEN is not configured");
  return t;
}

export async function hs(path, { method = "GET", body, fetchImpl = fetch } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!res.ok) {
      const err = new Error(`HubSpot ${method} ${path.split("?")[0]} → ${res.status}: ${data?.message || text}`.slice(0, 600));
      err.status = res.status; err.body = data;
      throw err;
    }
    return data;
  }
  throw new Error(`HubSpot ${method} ${path} kept failing (rate limited)`);
}

/** Property names HubSpot complained about in a 400. */
export function badProperties(err) {
  const names = new Set();
  const scan = (s) => {
    for (const m of String(s || "").matchAll(/Property \\?"?([a-z0-9_]+)\\?"? does not exist/gi)) names.add(m[1]);
    for (const m of String(s || "").matchAll(/"name":"([a-z0-9_]+)"/gi)) names.add(m[1]);
  };
  scan(err?.body?.message);
  for (const e of err?.body?.errors || []) { scan(e.message); if (e.context?.propertyName) e.context.propertyName.forEach((n) => names.add(n)); }
  return [...names];
}

/** Run a property write; on 400, drop the offending properties and retry. */
async function withPropRetry(props, fn) {
  let current = { ...props };
  const dropped = [];
  for (let i = 0; i < 4; i += 1) {
    try {
      const out = await fn(current);
      return { result: out, dropped };
    } catch (err) {
      if (err.status !== 400) throw err;
      const bad = badProperties(err).filter((n) => n in current);
      if (!bad.length) throw err;
      for (const b of bad) { dropped.push(b); delete current[b]; }
    }
  }
  throw new Error(`HubSpot rejected properties: ${dropped.join(", ")}`);
}

const clean = (props) => Object.fromEntries(Object.entries(props || {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));

// ── contacts ───────────────────────────────────────────────────────────────

export async function findContactByEmail(email) {
  const data = await hs("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: String(email).toLowerCase() }] }], properties: ["email", "firstname", "lastname"], limit: 1 },
  });
  return data?.results?.[0] || null;
}

/** Create or update the contact. Returns { id, dropped }. */
export async function upsertContact(email, props) {
  const existing = await findContactByEmail(email);
  const body = clean({ ...props, email: String(email).toLowerCase() });
  if (existing) {
    const { dropped } = await withPropRetry(body, (p) => hs(`/crm/v3/objects/contacts/${existing.id}`, { method: "PATCH", body: { properties: p } }));
    return { id: String(existing.id), created: false, dropped };
  }
  try {
    const { result, dropped } = await withPropRetry(body, (p) => hs("/crm/v3/objects/contacts", { method: "POST", body: { properties: p } }));
    return { id: String(result.id), created: true, dropped };
  } catch (err) {
    // Lost a race with the HubSpot forms tracker / another submission.
    if (err.status === 409) {
      const again = await findContactByEmail(email);
      if (again) return upsertContact(email, props);
    }
    throw err;
  }
}

/** Read some properties of a contact. */
export async function getContact(id, properties = []) {
  const q = properties.length ? `?properties=${properties.map(encodeURIComponent).join(",")}` : "";
  return hs(`/crm/v3/objects/contacts/${encodeURIComponent(id)}${q}`);
}

/** PATCH a contact, dropping properties the portal doesn't have. Returns { dropped }. */
export async function patchContact(id, props) {
  const body = clean(props);
  if (!Object.keys(body).length) return { dropped: [] };
  const { dropped } = await withPropRetry(body, (p) => hs(`/crm/v3/objects/contacts/${id}`, { method: "PATCH", body: { properties: p } }));
  return { dropped };
}

/** Poll until a contact with this email exists (HubSpot processes form submissions asynchronously). */
export async function waitForContact(email, { timeoutMs = 30000, everyMs = 2500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const c = await findContactByEmail(email);
    if (c) return c;
    if (Date.now() + everyMs > until) return null;
    await sleep(everyMs);
  }
}

// ── pipelines / properties ─────────────────────────────────────────────────

let _pipes = null;
export async function dealPipelines() {
  if (_pipes && Date.now() - _pipes.at < 10 * 60 * 1000) return _pipes.list;
  const data = await hs("/crm/v3/pipelines/deals");
  _pipes = { at: Date.now(), list: (data?.results || []).map((p) => ({ id: String(p.id), label: p.label, stages: (p.stages || []).map((s) => ({ id: String(s.id), label: s.label, displayOrder: s.displayOrder })) })) };
  return _pipes.list;
}

const _opts = new Map();
export async function propertyOptions(objectType, name) {
  const key = `${objectType}:${name}`;
  const hit = _opts.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.options;
  try {
    const data = await hs(`/crm/v3/properties/${objectType}/${name}`);
    const options = (data?.options || []).map((o) => ({ value: o.value, label: o.label, hidden: !!o.hidden }));
    _opts.set(key, { at: Date.now(), options });
    return options;
  } catch (err) {
    if (err.status === 404) { _opts.set(key, { at: Date.now(), options: [] }); return []; }
    throw err;
  }
}

// ── deals ──────────────────────────────────────────────────────────────────

const DEAL_PROPS = ["dealname", "pipeline", "dealstage", "amount", "pd_program", "travel_year", "createdate", ...Array.from({ length: 10 }, (_, i) => `payment_${i + 1}`)];

export async function getDeal(id) {
  return hs(`/crm/v3/objects/deals/${id}?properties=${DEAL_PROPS.join(",")}`);
}

export async function contactDeals(contactId) {
  const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=100`);
  const ids = (assoc?.results || []).map((r) => String(r.toObjectId));
  if (!ids.length) return [];
  const data = await hs("/crm/v3/objects/deals/batch/read", { method: "POST", body: { properties: DEAL_PROPS, inputs: ids.map((id) => ({ id })) } });
  return (data?.results || []).sort((a, b) => new Date(b.properties?.createdate || 0) - new Date(a.properties?.createdate || 0));
}

export async function createDeal(props, contactId) {
  const { result, dropped } = await withPropRetry(clean(props), (p) => hs("/crm/v3/objects/deals", {
    method: "POST",
    body: {
      properties: p,
      associations: contactId ? [{ to: { id: String(contactId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }] : [],
    },
  }));
  return { id: String(result.id), dropped };
}

export async function updateDeal(id, props) {
  const body = clean(props);
  if (!Object.keys(body).length) return { dropped: [] };
  const { dropped } = await withPropRetry(body, (p) => hs(`/crm/v3/objects/deals/${id}`, { method: "PATCH", body: { properties: p } }));
  return { dropped };
}

/** Attach a note to the contact (and deal) — used for the interview booking. */
export async function addNote(html, { contactId, dealId } = {}) {
  const associations = [];
  if (contactId) associations.push({ to: { id: String(contactId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] });
  if (dealId) associations.push({ to: { id: String(dealId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] });
  return hs("/crm/v3/objects/notes", { method: "POST", body: { properties: { hs_note_body: html, hs_timestamp: new Date().toISOString() }, associations } });
}

// ── associations ───────────────────────────────────────────────────────────

const _labels = new Map();
/** Association types between two object types: [{ category, typeId, label }]. */
export async function associationLabels(fromType, toType) {
  const key = `${fromType}>${toType}`;
  const hit = _labels.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  const data = await hs(`/crm/v4/associations/${fromType}/${toType}/labels`);
  const list = (data?.results || []).map((r) => ({ category: r.category, typeId: Number(r.typeId), label: r.label || null }));
  _labels.set(key, { at: Date.now(), list });
  return list;
}

/** Find a labelled association type: exact label first, then a regex fallback. */
export async function findLabel(fromType, toType, exact, fallbackRe) {
  const list = await associationLabels(fromType, toType).catch(() => []);
  const want = String(exact || "").trim().toLowerCase();
  return list.find((l) => (l.label || "").trim().toLowerCase() === want)
    || (fallbackRe ? list.find((l) => fallbackRe.test(l.label || "") && !/dnu|do not use/i.test(l.label || "")) : null)
    || null;
}

/**
 * Associate two records. With `type` ({category,typeId}) the labelled
 * association is added (on top of the default one); without it, the default
 * unlabelled association is created. Both calls are idempotent.
 */
export async function associate(fromType, fromId, toType, toId, type = null) {
  await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, { method: "PUT" });
  if (type) {
    await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`, {
      method: "PUT",
      body: [{ associationCategory: type.category || "USER_DEFINED", associationTypeId: Number(type.typeId) }],
    });
  }
}

let _programs = null;
/** Every Pacific Discovery program record (cached 10 minutes). */
export async function programRecords(objectType) {
  if (_programs && Date.now() - _programs.at < 10 * 60 * 1000) return _programs.list;
  const props = ["pacific_discovery_program", "program_name", "portal_title", "program_start_date", "program_end_date"];
  const list = [];
  let after = null;
  for (let i = 0; i < 50; i += 1) {
    const qs = new URLSearchParams({ limit: "100", properties: props.join(",") });
    if (after) qs.set("after", after);
    const page = await hs(`/crm/v3/objects/${objectType}?${qs}`);
    list.push(...(page?.results || []));
    after = page?.paging?.next?.after || null;
    if (!after) break;
  }
  _programs = { at: Date.now(), list };
  return list;
}

/**
 * Associate a contact with a program record using a PAIRED label (the program
 * object's labels come in pairs: the contact side reads "Program", the
 * program side reads "Student" / "Parent" / "Instructor").
 *
 * HubSpot only accepts a paired type id in its own direction, and which
 * direction holds "Student" depends on how the pair was created — so this
 * tries contact→program first, then program→contact, with the type id that
 * direction's label list gives for that name. Afterwards it reads the
 * association back and confirms the label is really there.
 *
 * Returns { label, typeId, direction, verified }.
 */
export async function associateWithRole(contactId, objectType, recordId, roleLabel, fallbackRe) {
  // Plain association first, so the records are linked even if labelling fails.
  await hs(`/crm/v4/objects/contacts/${contactId}/associations/default/${objectType}/${recordId}`, { method: "PUT" });
  const want = String(roleLabel).trim().toLowerCase();
  const pick = (list) => list.find((l) => (l.label || "").trim().toLowerCase() === want)
    || (fallbackRe ? list.find((l) => fallbackRe.test(l.label || "") && !/dnu|do not use/i.test(l.label || "")) : null);
  const fwd = pick(await associationLabels("contacts", objectType).catch(() => []));
  const rev = pick(await associationLabels(objectType, "contacts").catch(() => []));
  const attempts = [];
  if (fwd) attempts.push(["contacts→program", () => hs(`/crm/v4/objects/contacts/${contactId}/associations/${objectType}/${recordId}`, { method: "PUT", body: [{ associationCategory: fwd.category || "USER_DEFINED", associationTypeId: Number(fwd.typeId) }] }), fwd]);
  if (rev) attempts.push(["program→contacts", () => hs(`/crm/v4/objects/${objectType}/${recordId}/associations/contacts/${contactId}`, { method: "PUT", body: [{ associationCategory: rev.category || "USER_DEFINED", associationTypeId: Number(rev.typeId) }] }), rev]);
  if (!attempts.length) throw new Error(`No "${roleLabel}" association label exists between contacts and the program object`);
  const errors = [];
  for (const [direction, run, type] of attempts) {
    try {
      await run();
      const verified = await hasRole(contactId, objectType, recordId, roleLabel);
      if (verified !== false) return { label: type.label, typeId: type.typeId, direction, verified };
      errors.push(`${direction}: accepted but the "${roleLabel}" label isn't on the association`);
    } catch (err) { errors.push(`${direction}: ${err.message}`); }
  }
  throw new Error(`Couldn't add the "${roleLabel}" label — ${errors.join(" | ")}`);
}

/** true / false, or null when it can't be read back. */
export async function hasRole(contactId, objectType, recordId, roleLabel) {
  try {
    const data = await hs(`/crm/v4/objects/contacts/${contactId}/associations/${objectType}?limit=500`);
    const row = (data?.results || []).find((r) => String(r.toObjectId) === String(recordId));
    if (!row) return false;
    const typeIds = new Set((row.associationTypes || []).map((t) => Number(t.typeId)));
    const labelsHere = (row.associationTypes || []).map((t) => (t.label || "").toLowerCase());
    if (labelsHere.includes(String(roleLabel).toLowerCase())) return true;
    // Labels can come back null on paired types — compare type ids from both directions instead.
    const defs = [...(await associationLabels("contacts", objectType).catch(() => [])), ...(await associationLabels(objectType, "contacts").catch(() => []))];
    return defs.some((d) => typeIds.has(Number(d.typeId)) && (d.label || "").toLowerCase() === String(roleLabel).toLowerCase());
  } catch { return null; }
}
