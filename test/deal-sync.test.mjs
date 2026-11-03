// Program / season switches made on the HubSpot deal → the application follows.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setupDb, fakeUpstreams } from './harness.mjs';

Object.assign(process.env, {
  SMTP_USER: 'apply@pacificdiscovery.org', SMTP_PASS: 'x', APPLY_SITE_URL: 'https://apply.example.org',
  HUBSPOT_TOKEN: 'x', STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', APPLY_SERVICE_KEY: 'svc',
  ADMISSIONS_ALERT_EMAIL: 'admissions@pacificdiscovery.org',
});

const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
schema.settings = { ...(schema.settings || {}), cardFeeRate: 0.035, achFeeRate: 0.01 };
const { pool } = await setupDb(schema);
const up = fakeUpstreams();
const N = await import('../netlify/functions/_lib/notify.mjs');
const mails = [];
N.__setTransport({ sendMail: async (m) => { mails.push(m); return {}; } });
const { decide } = await import('../netlify/functions/_lib/decisions.mjs');
const DS = await import('../netlify/functions/_lib/deal-sync.mjs');
const accept = (await import('../netlify/functions/accept.mjs')).default;
const service = (await import('../netlify/functions/service.mjs')).default;
const quiet = { error() {}, warn() {} };

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const row = async (id) => (await pool.query('SELECT program, term, season, travel_year, answers, sync, enrolment FROM applications WHERE id = $1', [id])).rows[0];
const api = async (path, body) => {
  const res = await accept(new Request(`https://apply.example.org/api/accept/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined));
  return { status: res.status, body: await res.json() };
};

let deals = 900;
async function app(email, { accepted = false } = {}) {
  const deal = String(deals++);
  up.crm.deals.set(deal, { id: deal, properties: { pipeline: '74958084', dealstage: 'f9i', pd_program: 'South America Semester', travel_year: '2027' } });
  const answers = { preferredName: 'Sam', program: 'South America Gap Semester', term: 'Fall 2027', parent1Email: `parent.${email}` };
  const [{ id }] = (await pool.query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, season, travel_year, program_type, status, answers, step1_at, step2_at, interview_at, paid_at, payment, hubspot_contact_id, hubspot_deal_id, sync)
     VALUES ($1,$2,'Sam','Lee','South America Gap Semester','Fall 2027','Fall','2027','semester','paid',$3, now(), now(), now(), now(), $4, '501', $5, $6) RETURNING id`,
    [`h-${email}`, email, JSON.stringify(answers), JSON.stringify({ reference: 'pi_fee', base: 250 }), deal, JSON.stringify({ hsProgram: { record: { id: 'P5' } } })])).rows;
  let token = null;
  if (accepted) {
    await decide(id, { outcome: 'accepted', by: 'Megan' }, { schema, log: quiet });
    token = /\/accept\?token=([\w-]+)/.exec(mails.at(-1).text)[1];
  }
  return { id, deal, token };
}
const pipes = up.crm.pipelines;
const pdOptions = up.crm.pdOptions;

await t('dealChange (pure): season from the pipeline, year from Travel Year, program from PD Program; the application pipeline keeps the season', async () => {
  const a = { program: 'South America Gap Semester', term: 'Fall 2027', season: 'Fall', travel_year: '2027', program_type: 'semester' };
  const deal = (pipeline, extra = {}) => ({ properties: { pipeline, pd_program: 'South America Semester', travel_year: '2027', ...extra } });
  const pipe = (id) => pipes.find((p) => p.id === id);
  assert.equal(DS.dealChange(a, deal('74958084'), pipe('74958084'), { schema, pdOptions }), null, 'no change');
  const ch = DS.dealChange(a, deal('74759274', { travel_year: '2028' }), pipe('74759274'), { schema, pdOptions });
  assert.deepEqual(ch.changes, [{ field: 'term', from: 'Fall 2027', to: 'Spring 2028' }]);
  assert.equal(ch.season, 'Spring'); assert.equal(ch.year, '2028');
  assert.equal(DS.dealChange(a, deal('1'), pipe('1'), { schema, pdOptions }), null, 'PD Applications pipeline: season kept');
  const ch2 = DS.dealChange(a, deal('694619955', { pd_program: 'Bali Summer Program' }), pipe('694619955'), { schema, pdOptions });
  assert.deepEqual(ch2.changes.map((c) => c.field), ['program', 'term']);
  assert.equal(ch2.term, 'Summer 2027'); assert.equal(ch2.programType, 'summer');
  assert.match(ch2.program, /Bali/);
});

await t('season switched on the deal → application program/term/answers updated, change logged, HubSpot note', async () => {
  const { id, deal } = await app('sw1@x.org');
  Object.assign(up.crm.deals.get(deal).properties, { pipeline: '74759274', travel_year: '2027' });
  const out = await DS.syncFromDeals({ schema, log: quiet });
  assert.equal(out.changed.length, 1, JSON.stringify(out));
  const r = await row(id);
  assert.equal(r.term, 'Spring 2027'); assert.equal(r.season, 'Spring'); assert.equal(r.travel_year, '2027');
  assert.equal(r.answers.term, 'Spring 2027');
  assert.equal(r.sync.programChanges.length, 1);
  assert.ok(up.crm.notes.some((x) => /Application updated from the deal/.test(x.properties?.hs_note_body || x.html || JSON.stringify(x))));
  assert.equal((await DS.syncFromDeals({ schema, log: quiet })).changed.length, 0, 'once');
  assert.equal(out.changed[0].programRecord, 'P1', 'student/parents/deal moved to the Spring program record');
  assert.ok(!up.crm.assocLog.some((a) => a.toId === 'P5' && a.fromId === deal), 'old record unlinked from the deal');
});

await t('accepted, deposit not paid: the offer takes the new start date; the acceptance page shows it', async () => {
  const { id, deal, token } = await app('sw2@x.org', { accepted: true });
  assert.equal((await row(id)).enrolment.offer.start, '2027-09-09');
  Object.assign(up.crm.deals.get(deal).properties, { pipeline: '74759274', travel_year: '2027' }); // Spring 2027 → record P1 (Feb 3)
  await DS.syncFromDeals({ schema, log: quiet });
  const r = await row(id);
  assert.equal(r.term, 'Spring 2027');
  assert.equal(r.enrolment.offer.start, '2027-02-03');
  const o = (await api(`offer?token=${token}`)).body.offer;
  assert.equal(o.start, '2027-02-03'); assert.equal(o.term, 'Spring 2027');
});

await t('after the deposit: payments now due too late → admissions alerted to review', async () => {
  const { id, deal, token } = await app('sw3@x.org', { accepted: true });
  const r0 = await api('checkout', { token, plan: 'monthly', method: 'card', agree: true });
  const s = up.stripe.sessions.get(r0.body.url.split('/').pop());
  Object.assign(s, { status: 'complete', payment_status: 'paid' });
  await api(`offer?token=${token}&session_id=${s.id}`);
  Object.assign(up.crm.deals.get(deal).properties, { pipeline: '74759274', travel_year: '2027' });
  const before = mails.length;
  const out = await DS.syncFromDeals({ schema, log: quiet });
  const mine = out.changed.find((c) => c.id === id);
  assert.ok(mine.problems?.length, JSON.stringify(mine));
  assert.ok(mails.slice(before).some((m) => /Program switch needs a look/.test(m.subject) && /admissions@/.test(m.to)));
  assert.equal((await row(id)).enrolment.offer.start, '2027-02-03');
});

await t('no start date for the new term → offer unchanged, admissions told', async () => {
  const { id, deal } = await app('sw4@x.org', { accepted: true });
  Object.assign(up.crm.deals.get(deal).properties, { pipeline: '74759274', travel_year: '2031' });
  const before = mails.length;
  await DS.syncFromDeals({ schema, log: quiet });
  const r = await row(id);
  assert.equal(r.term, 'Spring 2031');
  assert.equal(r.enrolment.offer.start, '2027-09-09', 'kept');
  assert.ok(mails.slice(before).some((m) => /Program switch needs a look/.test(m.subject) && /No start date/.test(m.text)));
});

await t('"Retry sync" in the dashboard pulls a switch straight away', async () => {
  const { id, deal } = await app('sw5@x.org');
  Object.assign(up.crm.deals.get(deal).properties, { pipeline: '74759274', travel_year: '2028' });
  const res = await service(new Request('https://apply.example.org/api/service/resync', { method: 'POST', headers: { 'x-apply-key': 'svc', 'content-type': 'application/json' }, body: JSON.stringify({ id }) }));
  const b = await res.json();
  assert.equal(res.status, 200, JSON.stringify(b));
  assert.equal(b.fromDeal.changed.length, 1);
  assert.equal((await row(id)).term, 'Spring 2028');
  assert.ok(crypto);
});

up.restore();
await pool.end();
console.log(`deal-sync: ${n} passed`);
