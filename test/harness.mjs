// Test harness: real Postgres (local), in-memory Blobs, and fake HubSpot /
// Jotform / Stripe behind a stubbed fetch. Lets the real function handlers run
// end to end. Requires a local Postgres; set TEST_PG_URL.
import pg from 'pg';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { __setSql, FORM_ID } from '../netlify/functions/_lib/db.mjs';

export const PG_URL = process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply';

export async function setupDb(schema) {
  const pool = new pg.Pool({ connectionString: PG_URL });
  const toText = (strings, vals) => strings.reduce((acc, s, i) => acc + s + (i < vals.length ? `$${i + 1}` : ''), '');
  const sql = async (strings, ...vals) => (await pool.query(toText(strings, vals), vals)).rows;
  sql.query = async (text, params = []) => (await pool.query(text, params)).rows;
  __setSql(sql);
  await pool.query('TRUNCATE apply_files, applications, apply_form_versions, apply_forms CASCADE');
  await pool.query(`INSERT INTO apply_forms (id, draft, published, published_rev) VALUES ($1, $2, $2, 1)`, [FORM_ID, JSON.stringify(schema)]);
  return { pool, sql };
}

export function memoryStore() {
  const m = new Map();
  return {
    m,
    async set(k, v, opts) { m.set(k, { v: Buffer.from(v), meta: opts?.metadata }); },
    async get(k) { const x = m.get(k); return x ? x.v.buffer.slice(x.v.byteOffset, x.v.byteOffset + x.v.length) : null; },
  };
}

/** Fake CRM + Jotform + Stripe. Returns { calls, crm, restore }. */
export function fakeUpstreams({ pdOptions } = {}) {
  const calls = [];
  const crm = {
    contacts: new Map(), deals: new Map(), assoc: new Map(), notes: [], seq: 100,
    pipelines: [
      { id: '1', label: 'PD Applications', stages: [{ id: 'a1', label: 'Application Received', displayOrder: 0 }, { id: 'a2', label: 'Application Complete', displayOrder: 1 }] },
      { id: '694619955', label: 'Summer Program', stages: [{ id: 's9', label: 'Application Fee Received', displayOrder: 1 }] },
      { id: '74958084', label: 'Fall Semester', stages: [{ id: 'f9', label: 'Application Fee Received' }] },
      { id: '74759274', label: 'Spring Semester', stages: [{ id: 'p9', label: 'Application Fee Received' }] },
      { id: '74958085', label: 'Fall Mini Semester', stages: [{ id: 'fm9', label: 'Application Fee Received' }] },
      { id: '74755425', label: 'Spring Mini Semester', stages: [{ id: 'sm9', label: 'Application Fee Received' }] },
    ],
    assocLog: [],
    programs: [
      { id: '54796059552', properties: { program_name: 'Global defaults' } },
      { id: 'P1', properties: { pacific_discovery_program: 'South America Semester', program_start_date: '2027-02-03' } },
      { id: 'P2', properties: { pacific_discovery_program: 'South America Semester', program_start_date: '2026-09-02' } },
      { id: 'P3', properties: { pacific_discovery_program: 'Bali Summer Program', program_start_date: '2027-06-20' } },
      { id: 'P4', properties: { pacific_discovery_program: 'Costa Rica Mini Semester', program_start_date: '2027-09-10' } },
    ],
    pdOptions: pdOptions || [{ value: 'Bali Summer Program', label: 'Bali Summer Program' }, { value: 'South America Semester', label: 'South America Semester' }],
  };
  const jot = { subs: new Map(), seq: 6000 };
  const stripe = { sessions: new Map(), seq: 1 };
  const realFetch = globalThis.fetch;
  const J = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body;
    calls.push({ host: url.host, method, path: url.pathname, body: typeof body === 'string' ? body : null });

    if (url.host === 'api.hubapi.com') {
      const b = body ? JSON.parse(body) : {};
      const p = url.pathname;
      if (p === '/crm/v3/objects/contacts/search') {
        const email = b.filterGroups[0].filters[0].value;
        const c = [...crm.contacts.values()].find((x) => x.properties.email === email);
        return J({ results: c ? [c] : [] });
      }
      if (p === '/crm/v3/objects/contacts' && method === 'POST') {
        if ('bogus_prop' in b.properties) return J({ message: 'Property values were not valid', errors: [{ message: 'Property "bogus_prop" does not exist', context: { propertyName: ['bogus_prop'] } }] }, 400);
        const id = String(crm.seq++); crm.contacts.set(id, { id, properties: b.properties }); return J({ id });
      }
      let m;
      if ((m = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(p)) && method === 'PATCH') {
        Object.assign(crm.contacts.get(m[1]).properties, b.properties); return J({ id: m[1] });
      }
      if (p === '/crm/v3/pipelines/deals') return J({ results: crm.pipelines });
      if (p === '/crm/v3/properties/deals/pd_program') return J({ options: crm.pdOptions });
      if (p === '/crm/v3/objects/deals' && method === 'POST') {
        const id = String(crm.seq++);
        crm.deals.set(id, { id, properties: { ...b.properties, createdate: new Date().toISOString() } });
        for (const a of b.associations || []) crm.assoc.set(a.to.id, [...(crm.assoc.get(a.to.id) || []), id]);
        return J({ id });
      }
      if ((m = /^\/crm\/v3\/objects\/deals\/(\d+)$/.exec(p))) {
        const d = crm.deals.get(m[1]);
        if (!d) return J({ message: 'not found' }, 404);
        if (method === 'PATCH') { Object.assign(d.properties, b.properties); return J({ id: d.id }); }
        return J(d);
      }
      if ((m = /^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/deals$/.exec(p))) {
        return J({ results: (crm.assoc.get(m[1]) || []).map((id) => ({ toObjectId: Number(id) })) });
      }
      if (p === '/crm/v3/objects/deals/batch/read') return J({ results: b.inputs.map((i) => crm.deals.get(i.id)).filter(Boolean) });
      if (p === '/crm/v3/objects/notes') { crm.notes.push(b); return J({ id: 'n1' }); }
      if (p === '/crm/v4/associations/contacts/contacts/labels') return J({ results: [{ category: 'USER_DEFINED', typeId: 51, label: 'Parent' }, { category: 'USER_DEFINED', typeId: 52, label: 'Child' }] });
      if (p === '/crm/v4/associations/deals/contacts/labels') return J({ results: [{ category: 'HUBSPOT_DEFINED', typeId: 3, label: null }, { category: 'USER_DEFINED', typeId: 61, label: 'Student' }, { category: 'USER_DEFINED', typeId: 62, label: 'Parent' }] });
      if (p === '/crm/v4/associations/contacts/2-58411705/labels') return J({ results: [{ category: 'USER_DEFINED', typeId: 71, label: 'Student' }, { category: 'USER_DEFINED', typeId: 72, label: 'Parent' }, { category: 'USER_DEFINED', typeId: 28, label: 'Instructor' }] });
      if (p === '/crm/v3/objects/2-58411705') return J({ results: crm.programs });
      if ((m = /^\/crm\/v4\/objects\/([^/]+)\/([^/]+)\/associations\/(default\/)?([^/]+)\/([^/]+)$/.exec(p)) && method === 'PUT') {
        const [, from, fromId, dflt, to, toId] = m;
        const types = dflt ? [null] : b.map((t) => t.associationTypeId);
        for (const typeId of types) crm.assocLog.push({ from, fromId, to, toId, typeId });
        return J({ ok: true });
      }
      return J({ message: `fake hubspot: unhandled ${method} ${p}` }, 404);
    }

    if (url.host === 'api.jotform.com') {
      let m;
      if ((m = /^\/form\/(\d+)\/submissions$/.exec(url.pathname)) && method === 'POST') {
        const id = String(jot.seq++);
        jot.subs.set(id, { form: m[1], params: Object.fromEntries(new URLSearchParams(body)) });
        return J({ responseCode: 200, content: { submissionID: id } });
      }
      if ((m = /^\/submission\/(\d+)$/.exec(url.pathname)) && method === 'POST') {
        Object.assign(jot.subs.get(m[1]).params, Object.fromEntries(new URLSearchParams(body)));
        return J({ responseCode: 200 });
      }
      return J({ message: 'fake jotform unhandled' }, 404);
    }

    if (url.host === 'api.stripe.com') {
      const p = url.pathname;
      if (p === '/v1/customers' && method === 'GET') return J({ data: [] });
      if (p === '/v1/customers' && method === 'POST') return J({ id: 'cus_1' });
      if (p === '/v1/checkout/sessions' && method === 'POST') {
        const f = new URLSearchParams(body);
        const id = `cs_test_${stripe.seq++}`;
        const amount = [0, 1].reduce((acc, i) => acc + Number(f.get(`line_items[${i}][price_data][unit_amount]`) || 0), 0);
        const meta = {};
        for (const [k, v] of f) { const mm = /^metadata\[(\w+)\]$/.exec(k); if (mm) meta[mm[1]] = v; }
        const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, client_reference_id: f.get('client_reference_id'), amount_total: amount, currency: 'usd', metadata: meta, payment_status: 'unpaid', payment_intent: `pi_${id}`, created: Math.floor(Date.now() / 1000), success_url: f.get('success_url'), form: f };
        stripe.sessions.set(id, s);
        return J(s);
      }
      let m;
      if ((m = /^\/v1\/checkout\/sessions\/(.+)$/.exec(p))) return J(stripe.sessions.get(m[1]) || {}, stripe.sessions.has(m[1]) ? 200 : 404);
      return J({ error: { message: 'fake stripe unhandled' } }, 404);
    }

    if (url.pathname.startsWith('/.netlify/functions/apply-sync-background')) return new Response('nope', { status: 404 }); // force inline sync
    return realFetch(input, init);
  };
  return { calls, crm, jot, stripe, restore: () => { globalThis.fetch = realFetch; } };
}

/** Minimal local server: static public/ + the function routes. */
export async function startServer(port = 8899) {
  const apply = (await import('../netlify/functions/apply.mjs')).default;
  const service = (await import('../netlify/functions/service.mjs')).default;
  const file = (await import('../netlify/functions/file.mjs')).default;
  const webhook = (await import('../netlify/functions/stripe-webhook.mjs')).default;
  const root = new URL('../public/', import.meta.url).pathname;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' });
    let out;
    if (url.pathname.startsWith('/api/apply/')) out = await apply(r, { ip: '127.0.0.1' });
    else if (url.pathname.startsWith('/api/service/')) out = await service(r);
    else if (url.pathname.startsWith('/api/file/')) out = await file(r, { params: { id: url.pathname.split('/').pop() } });
    else if (url.pathname === '/api/stripe-webhook') out = await webhook(r);
    if (out) {
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let p = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise((r) => server.listen(port, r));
  return server;
}
