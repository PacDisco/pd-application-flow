// Neon connection. pd-apply shares the pd-dashboard database (the Apply Form
// editor writes the schema there; this site writes applications there), so
// the URL is copied from the dashboard site's NETLIFY_DATABASE_URL.
import { neon } from "@neondatabase/serverless";

let _sql;
/** Tests inject a node-postgres backed stand-in with the same interface. */
export function __setSql(fn) { _sql = fn; }
export function db() {
  if (!_sql) {
    const url = process.env.APPLY_DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("APPLY_DATABASE_URL is not configured");
    _sql = neon(url);
  }
  return _sql;
}

export const FORM_ID = "pd-application";

let _schemaCache = null;
const SCHEMA_TTL_MS = 30 * 1000;

/** The PUBLISHED form schema (with its rev), cached briefly per warm container. */
export async function publishedSchema({ fresh = false } = {}) {
  if (!fresh && _schemaCache && Date.now() - _schemaCache.at < SCHEMA_TTL_MS) return _schemaCache;
  const rows = await db()`SELECT published, published_rev FROM apply_forms WHERE id = ${FORM_ID}`;
  const row = rows[0];
  if (!row || !row.published) throw Object.assign(new Error("The application form has not been published yet."), { status: 503 });
  _schemaCache = { at: Date.now(), schema: row.published, rev: row.published_rev };
  return _schemaCache;
}
