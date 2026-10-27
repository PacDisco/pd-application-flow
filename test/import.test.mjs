// Adding an older (Jotform-era) applicant from HubSpot so they can be accepted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDb, fakeUpstreams } from './harness.mjs';

Object.assign(process.env, {
  SMTP_USER: 'apply@pacificdiscovery.org', SMTP_PASS: 'x', APPLY_SITE_URL: 'https://apply.example.org',
  HUBSPOT_TOKEN: 'x', STRIPE_SECRET_KEY: 'sk_test', APPLY_SERVICE_KEY: 'svc',
});
const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
const { pool } = await setupDb(schema);
const up = fakeUpstreams();
const N = await import('../netlify/functions/_lib/notify.mjs');
const mails = [];
N.__setTransport({ sendMail: async (m) => { mails.push(m); return {}; } });
const service = (await import('../netlify/functions/service.mjs')).default;
const IMP = await import('../netlify/functions/_lib/import.mjs');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const svc = async (route, body) => {
  const res = await service(new Request(`https://apply.example.org/api/service/${route}`, { method: 'POST', headers: { 'x-apply-key': 'svc', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

// An older applicant: student + mum on a Fall Semester deal at "Interview Complete", fee + $1,000 paid.
up.crm.contacts.set('301', { id: '301', properties: { email: 'old@x.org', firstname: 'Olive', lastname: 'Dean' } });
up.crm.contacts.set('302', { id: '302', properties: { email: 'mum@x.org', firstname: 'Mary', lastname: 'Dean' } });
up.crm.deals.set('880', { id: '880', properties: { dealname: 'Olive Dean - South America Semester', pipeline: '74958084', dealstage: 'f9c', amount: '15500', pd_program: 'South America Semester', travel_year: '2027', createdate: '2026-06-01T00:00:00Z', payment_1: '250, 1234, 2026-06-02', payment_2: '1000, Wise 77, 2026-07-01' } });
up.crm.assoc.set('301', ['880']); up.crm.assoc.set('302', ['880']);

await t('dealFacts: program, type, season and term from the pipeline + travel year', () => {
  const pipe = (label) => ({ label });
  assert.deepEqual(IMP.dealFacts({ properties: { pd_program: 'Hawaii Mini Semester', travel_year: '2027' } }, pipe('Fall Mini Semester')),
    { program: 'Hawaii Mini Semester', programType: 'mini', season: 'Fall', year: '2027', term: 'Fall 2027' });
  assert.equal(IMP.dealFacts({ properties: { dealname: 'A B - Bali Summer Program', travel_year: '2027' } }, pipe('Summer Program')).programType, 'summer');
  assert.equal(IMP.dealFacts({ properties: { pd_program: 'X' } }, pipe('PD Applications')).term, null);
});

let appId;
await t('lookup by email lists their deals with pipeline, stage and what has been paid', async () => {
  const r = await svc('hubspot-lookup', { email: 'OLD@x.org' });
  assert.equal(r.status, 200);
  assert.equal(r.body.contact.first, 'Olive');
  assert.deepEqual(r.body.deals.map((d) => [d.id, d.pipeline, d.stage, d.paid, d.term, d.applicationId]), [['880', 'Fall Semester', 'Interview Complete', 1250, 'Fall 2027', null]]);
  assert.deepEqual((await svc('hubspot-lookup', { email: 'nobody@x.org' })).body.deals, []);
});

await t('import creates an application ready to accept: no emails, no fee reminders, parents from the deal', async () => {
  const before = mails.length;
  const r = await svc('import', { email: 'old@x.org', dealId: '880', by: 'Megan' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  appId = r.body.id;
  assert.deepEqual(r.body.parents, ['mum@x.org']);
  const a = (await pool.query('SELECT * FROM applications WHERE id = $1', [appId])).rows[0];
  assert.equal(a.program, 'South America Semester'); assert.equal(a.term, 'Fall 2027'); assert.equal(Number(a.deal_amount), 15500);
  assert.equal(a.status, 'paid'); assert.ok(a.paid_at); assert.ok(a.interview_at);
  assert.equal(a.answers.parent1Email, 'mum@x.org');
  assert.ok(a.reminders.stopped, 'no fee reminders for imported applicants');
  assert.equal(mails.length, before, 'nobody emailed');
  assert.equal((await svc('import', { email: 'old@x.org', dealId: '880' })).status, 409, 'once per deal');
  assert.equal((await svc('hubspot-lookup', { email: 'old@x.org' })).body.deals[0].applicationId, appId);
});

await t('then Accept works as for anyone: offer from the deal price + program record, $1,250 already paid → $1,250 deposit due', async () => {
  const r = await svc('decision', { id: appId, outcome: 'accepted', by: 'Megan' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.decision.offer.tuition, 15500);
  assert.equal(r.body.decision.offer.paid, 1250); assert.equal(r.body.decision.offer.deposit, 1250);
  const m = mails.at(-1);
  assert.equal(m.to, 'old@x.org, mum@x.org');
  assert.match(m.text, /\$1,250 deposit/);
});

await t('decline of an imported applicant never tries a Stripe refund', async () => {
  up.crm.contacts.set('303', { id: '303', properties: { email: 'old2@x.org', firstname: 'Ann', lastname: 'Lee' } });
  up.crm.deals.set('881', { id: '881', properties: { dealname: 'Ann Lee - South America Semester', pipeline: '74958084', dealstage: 'f9i', amount: '15500', pd_program: 'South America Semester', travel_year: '2027', payment_1: '250, 999, 2026-06-02' } });
  up.crm.assoc.set('303', ['881']);
  const { body } = await svc('import', { email: 'old2@x.org', dealId: '881', by: 'Megan' });
  const refunds = (up.stripe.refunds || []).length;
  const r = await svc('decision', { id: body.id, outcome: 'declined', by: 'Megan' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((up.stripe.refunds || []).length, refunds);
});

up.restore();
await pool.end();
console.log(`import: ${n} passed`);
