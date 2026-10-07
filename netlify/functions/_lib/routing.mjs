// Pure HubSpot routing rules — which pipeline, stage, PD Program and travel
// year a deal gets. No I/O here; covered by test/routing.test.mjs.
//
// Pipelines (labels as they are in HubSpot; ids are the known fallbacks from
// pd-dashboard/netlify/functions/enrollment.js):
//   PD Applications        ← every new applicant (step 1)
//   Summer Program         694619955
//   Fall Semester          74958084
//   Spring Semester        74759274
//   Fall Mini Semester     74958085
//   Spring Mini Semester   74755425
// When the application fee is paid the deal moves out of PD Applications into
// the program pipeline chosen from the program's type and the travel season.

export const APPLICANT_PIPELINE = /^pd\s+applications?$/i;

export const KNOWN_PIPELINE_IDS = {
  "Summer Program": "694619955",
  "Fall Semester": "74958084",
  "Spring Semester": "74759274",
  "Fall Mini Semester": "74958085",
  "Spring Mini Semester": "74755425",
};

export const STAGES = {
  applicationReceived: [/application\s*(received|started|submitted)/i, /^new\s*application/i],
  applicationComplete: [/application\s*complete/i],
  interviewBooked: [/interview\s*(scheduled|booked)/i],
  appFee: [/application\s*fee\s*(received|paid)/i],
};

/** "Summer Program" | "Fall Semester" | … or null when it can't be decided. */
export function targetPipelineLabel(programType, season) {
  const s = String(season || "").toLowerCase();
  if (programType === "summer" || s === "summer") return "Summer Program";
  if (s !== "fall" && s !== "spring") return null;
  const S = s === "fall" ? "Fall" : "Spring";
  if (programType === "mini") return `${S} Mini Semester`;
  if (programType === "semester") return `${S} Semester`;
  return null;
}

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/** Find a pipeline by label (tolerant of "Program"/"Programs", "Mini-Semester"). */
const pipeKey = (s) => squash(s).replace(/\bprograms\b/g, "program").replace(/\bminisemester\b/g, "mini semester");
export function findPipeline(pipelines, label) {
  if (!label) return null;
  const want = pipeKey(label);
  const list = Array.isArray(pipelines) ? pipelines : [];
  const hit = list.find((p) => pipeKey(p.label) === want);
  if (hit) return hit;
  const id = KNOWN_PIPELINE_IDS[label];
  return id ? list.find((p) => String(p.id) === id) || { id, label, stages: [] } : null;
}

/** The application pipeline: HUBSPOT_APPLICATION_PIPELINE (label or id) or "PD Applications". */
export function findApplicantPipeline(pipelines, override = "") {
  const list = pipelines || [];
  if (override) {
    const o = String(override).trim();
    const hit = list.find((p) => String(p.id) === o) || list.find((p) => squash(p.label) === squash(o));
    if (hit) return hit;
  }
  return list.find((p) => APPLICANT_PIPELINE.test(p.label || "")) || null;
}

export function findStage(pipeline, kind) {
  const pats = STAGES[kind] || [];
  const stages = [...(pipeline?.stages || [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  for (const re of pats) {
    const s = stages.find((x) => re.test(x.label || ""));
    if (s) return s;
  }
  return null;
}

// ── PD Program enumeration ─────────────────────────────────────────────────

const STOP = new Set(["gap", "program", "programs", "the", "and", "semester", "year"]);
function tokens(s) {
  return squash(String(s || "").replace(/&/g, " and ")).split(" ").filter((t) => t && !STOP.has(t));
}

/**
 * Match a program name to one of HubSpot's PD Program options.
 * `explicit` (the value set on the program in the dashboard) always wins when
 * it is a real option. Returns the option VALUE, or "" when nothing is close.
 */
export function matchPdProgram(options, programName, explicit = "") {
  const opts = (options || []).filter((o) => o && o.value != null && !o.hidden);
  if (explicit) {
    const e = String(explicit).trim().toLowerCase();
    const hit = opts.find((o) => String(o.value).toLowerCase() === e || String(o.label).toLowerCase() === e);
    if (hit) return hit.value;
    if (!opts.length) return explicit; // options unknown — trust the editor
  }
  const want = tokens(programName);
  if (!want.length) return "";
  const kind = /summer|field/i.test(programName) ? "summer" : /mini/i.test(programName) ? "mini" : "semester";
  let best = null;
  for (const o of opts) {
    const label = String(o.label || o.value);
    const okind = /summer|field/i.test(label) ? "summer" : /mini/i.test(label) ? "mini" : "semester";
    if (okind !== kind) continue;
    const have = tokens(label);
    if (!have.length) continue;
    const common = want.filter((t) => have.includes(t)).length;
    const score = common / Math.max(want.length, have.length);
    if (common === want.length && have.length === want.length) return o.value; // same words
    if (!best || score > best.score) best = { score, value: o.value };
  }
  return best && best.score >= 0.67 ? best.value : "";
}

// ── payment_N ──────────────────────────────────────────────────────────────

export const PAYMENT_FIELDS = Array.from({ length: 10 }, (_, i) => `payment_${i + 1}`);

/** "250, pi_123, 2026-10-08" — the format the student portal already parses. */
export function paymentEntry(amount, reference, date = new Date()) {
  const d = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const amt = Number(amount);
  return `${Number.isInteger(amt) ? amt : amt.toFixed(2)}, ${reference}, ${d}`;
}

/**
 * Which payment_N to write, or null when the reference is already recorded
 * (webhook retries, the return-page check and the webhook racing each other).
 */
export function choosePaymentSlot(dealProps, reference) {
  const props = dealProps || {};
  if (reference && PAYMENT_FIELDS.some((k) => String(props[k] || "").includes(reference))) return null;
  return PAYMENT_FIELDS.find((k) => !String(props[k] || "").trim()) || null;
}

/** Deal properties for the application-fee move. */
export function appFeeDealUpdate({ facts, pipeline, stage, pdProgram, dealProps, payment }) {
  const props = {};
  if (pipeline?.id) props.pipeline = String(pipeline.id);
  if (stage?.id) props.dealstage = String(stage.id);
  if (pdProgram) props.pd_program = pdProgram;
  if (facts?.year) props.travel_year = String(facts.year);
  if (facts?.price != null && !Number(dealProps?.amount)) props.amount = String(facts.price);
  if (payment) {
    const slot = choosePaymentSlot(dealProps, payment.reference);
    if (slot) props[slot] = paymentEntry(payment.amount, payment.reference, payment.date);
  }
  return props;
}
