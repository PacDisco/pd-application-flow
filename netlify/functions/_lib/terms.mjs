// Published Program Terms & Conditions (edited in the dashboard's Apply Form →
// Terms tab; see MIGRATION-terms.sql in pd-dashboard).
import { db } from "./db.mjs";
import { TERMS_DOC_ID } from "../../../public/terms-kit.mjs";

let _cache = null;
const TTL_MS = 60 * 1000;

/** The live version (highest), or a specific one. null when nothing is published. */
export async function publishedTerms({ version = null, fresh = false } = {}) {
  if (version == null && !fresh && _cache && Date.now() - _cache.at < TTL_MS) return _cache.terms;
  const rows = version == null
    ? await db().query(
      `SELECT version, title, body, published_at FROM apply_terms_versions WHERE doc_id = $1 ORDER BY version DESC LIMIT 1`,
      [TERMS_DOC_ID])
    : await db().query(
      `SELECT version, title, body, published_at FROM apply_terms_versions WHERE doc_id = $1 AND version = $2`,
      [TERMS_DOC_ID, Number(version)]);
  const r = rows[0];
  const terms = r ? { version: Number(r.version), title: r.title, body: r.body, publishedAt: r.published_at } : null;
  if (version == null) _cache = { at: Date.now(), terms };
  return terms;
}

/** Best-effort: emails and payments still work if the table isn't there yet. */
export async function publishedTermsOrNull(opts) {
  try { return await publishedTerms(opts); }
  catch (err) { console.warn("[terms] not available:", err.message); return null; }
}

export function __clearTermsCache() { _cache = null; }
