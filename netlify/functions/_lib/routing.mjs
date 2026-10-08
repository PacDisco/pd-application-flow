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

// ── Pacific Discovery program custom object (2-58411705) ───────────────────
// One record per departure (e.g. "Bali Summer Program" starting June 2027).
// The application only knows the program name and the travel term, so the
// record is found by name + season + year.

export const PROGRAM_OBJECT_TYPE = process.env.HUBSPOT_PROGRAM_OBJECT || "2-58411705";
// The shared "global" defaults record used by the portal — never a departure.
export const GLOBAL_PROGRAM_RECORD_IDS = new Set(["54796059552"]);

const SEASON_WORDS = ["spring", "summer", "fall", "autumn", "winter"];
const kindOf = (s) => (/summer|field program/i.test(s) ? "summer" : /mini/i.test(s) ? "mini" : "semester");

/** Season of a departure from its start month (Pacific Discovery calendar). */
export function seasonFromDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getUTCMonth() + 1;
  if (m <= 4) return "Spring";      // Jan–Apr departures are spring semesters / minis
  if (m <= 7) return "Summer";      // May–Jul
  return "Fall";                    // Aug–Dec
}

function recordFacts(rec) {
  const p = rec.properties || {};
  const name = p.pacific_discovery_program || p.program_name || p.portal_title || "";
  const allText = [p.pacific_discovery_program, p.program_name, p.portal_title].filter(Boolean).join(" ");
  const start = p.program_start_date || p.program_end_date || null;
  let season = seasonFromDate(start);
  let year = start && !Number.isNaN(new Date(start).getTime()) ? String(new Date(start).getUTCFullYear()) : null;
  // Season / year written in the name win over the date guess.
  const sw = SEASON_WORDS.find((w) => new RegExp(`\\b${w}\\b`, "i").test(allText));
  if (sw && sw !== "summer") season = sw === "autumn" ? "Fall" : sw[0].toUpperCase() + sw.slice(1);
  const ym = /\b(20\d{2})\b/.exec(allText);
  if (ym) year = ym[1];
  const cleanName = String(name).replace(/\b(19|20)\d{2}\b/g, " ").replace(/\b(spring|fall|autumn|winter)\b/gi, " ");
  return { id: String(rec.id), name, cleanName, allText, season, year, kind: kindOf(allText || name) };
}

/**
 * Pick the program record for an application.
 * Returns { record, reason, candidates } — record is null when nothing (or
 * more than one equally good record) matches, so nothing is mis-associated.
 */
export function matchProgramRecord(records, { program, pdProgram, programType, season, year }) {
  const want = [tokens(program), pdProgram ? tokens(pdProgram) : null].filter((t) => t && t.length);
  const wantKind = programType || kindOf(program || "");
  const scored = [];
  for (const rec of records || []) {
    if (GLOBAL_PROGRAM_RECORD_IDS.has(String(rec.id))) continue;
    const f = recordFacts(rec);
    if (!f.name) continue;
    if (f.kind !== wantKind && !(wantKind === "semester" && f.kind === "semester")) continue;
    if (year && f.year && String(f.year) !== String(year)) continue;
    if (season && f.season && f.season !== season) continue;
    const have = tokens(f.cleanName);
    if (!have.length) continue;
    let best = 0;
    for (const w of want) {
      const common = w.filter((t) => have.includes(t)).length;
      best = Math.max(best, common / Math.max(w.length, have.length));
    }
    if (best >= 0.67) scored.push({ ...f, score: best + (f.year ? 0.01 : 0) + (f.season ? 0.01 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 5).map(({ id, name, season: s, year: y, score }) => ({ id, name, season: s, year: y, score: Math.round(score * 100) / 100 }));
  if (!scored.length) return { record: null, reason: `No HubSpot program record matches ${program} ${season || ""} ${year || ""}`.trim(), candidates };
  if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 0.005) {
    return { record: null, reason: `More than one HubSpot program record matches ${program} ${season || ""} ${year || ""}`.trim(), candidates };
  }
  return { record: { id: scored[0].id, name: scored[0].name, season: scored[0].season, year: scored[0].year }, reason: null, candidates };
}

/** Parent / guardian contacts from the step-2 answers (skips blanks and the student's own email). */
export function parentContacts(answers, studentEmail) {
  const out = [];
  const seen = new Set([String(studentEmail || "").toLowerCase()]);
  for (const n of [1, 2]) {
    const email = String(answers?.[`parent${n}Email`] || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = answers[`parent${n}Name`] || {};
    const phone = answers[`parent${n}Phone`];
    const addr = answers[`parent${n}Address`] || {};
    const props = {
      email,
      firstname: name.first || undefined,
      lastname: name.last || undefined,
      phone: phone?.number ? [phone.cc ? `+${String(phone.cc).replace(/\D/g, "")}` : "", phone.number].filter(Boolean).join(" ") : undefined,
      address: [addr.addr_line1, addr.addr_line2].filter(Boolean).join(", ") || undefined,
      city: addr.city || undefined,
      state: addr.state || undefined,
      zip: addr.postal || undefined,
      country: answers[`parent${n}Country`] || undefined,
    };
    out.push({ which: n === 1 ? "primary" : "secondary", relationship: answers[`parent${n}Relationship`] || "", props });
  }
  return out;
}
