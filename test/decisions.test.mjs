// Admissions decisions: accept / decline (refund, email, HubSpot), via the
// service API the dashboard calls. Needs TEST_PG_URL with MIGRATION-apply.sql
// and MIGRATION-decisions.sql.
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
up.crm.deals.set('900', { id: '900', properties: { pipeline: '74759274', dealstage: 'p9' } });
const N = await import('../netlify/functions/_lib/notify.mjs');
const mails = [];
N.__setTransport({ sendMail: async (m) => { mails.push(m); return {}; } });
const service = (await import('../netlify/functions/service.mjs')).default;
const { decide } = await import('../netlify/functions/_lib/decisions.mjs');

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const call = async (body, key = 'svc') => {
  const res = await service(new Request('https://apply.example.org/api/service/decision', { method: 'POST', headers: { 'x-apply-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
async function insertApp(email, { paid = true, record = 'P5' } = {}) {
  const answers = { preferredName: 'Sam', parent1Email: `parent.${email}`, parent1Name: { first: 'P', last: 'Q' } };
  const [r] = (await pool.query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, interview_at, paid_at, payment, hubspot_contact_id, hubspot_deal_id, sync)
     VALUES ($1,$2,'Sam','Lee','South America Gap Semester','Spring 2027',$3,$4, now(), now(), now(), $5, $6, '501', '900', $7) RETURNING id`,
    [`h-${email}`, email, paid ? 'paid' : 'interview', JSON.stringify(answers), paid ? new Date() : null,
      paid ? JSON.stringify({ reference: `pi_${email.split('@')[0]}`, base: 250, total: 258.75, currency: 'usd' }) : null,
      JSON.stringify(record ? { hsProgram: { record: { id: record } } } : {})])).rows;
  return r.id;
}
const decision = async (id) => (await pool.query('SELECT decision FROM applications WHERE id = $1', [id])).rows[0].decision;

await t('service API needs the key', async () => {
  assert.equal((await call({ id: 'x', outcome: 'accepted' }, 'wrong')).status, 403);
});

await t('accept: needs the fee paid; holds the place 7 days; deal → Interview Complete; acceptance email; HubSpot note', async () => {
  const unpaid = await insertApp('unpaid@x.org', { paid: false });
  const r0 = await call({ id: unpaid, outcome: 'accepted', by: 'Megan' });
  assert.equal(r0.status, 409); assert.match(r0.body.error, /hasn't been paid/);
  assert.equal(await decision(unpaid), null, 'nothing stored');

  const id = await insertApp('acc@x.org');
  const before = mails.length;
  const r = await call({ id, outcome: 'accepted', by: 'Megan', message: 'Loved talking with you!' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await decision(id);
  assert.deepEqual({ tuition: d.offer.tuition, paid: d.offer.paid, deposit: d.offer.deposit, start: d.offer.start, rec: d.offer.programRecordId },
    { tuition: 15500, paid: 250, deposit: 2250, start: '2027-09-09', rec: 'P5' });
  const en = (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [id])).rows[0].enrolment;
  assert.equal(en.offer.start, '2027-09-09');
  assert.equal(mails.length, before + 1);
  const m = mails.at(-1);
  assert.equal(m.to, 'acc@x.org, parent.acc@x.org');
  assert.match(m.subject, /accepted|place/i);
  assert.match(m.text, /Loved talking with you!/);
  assert.match(m.text, /\$2,250/);
  const link = /https:\/\/apply\.example\.org\/accept\?token=([\w-]+)/.exec(m.text);
  assert.ok(link, 'personal acceptance link');
  assert.match(m.html, /href="https:\/\/apply\.example\.org\/accept\?token=/);
  assert.ok(!/\{\w+\}/.test(m.text), 'no unfilled placeholders');
  assert.ok(d.email?.hubspot?.id, 'logged in HubSpot');
  const logged = up.crm.emails.at(-1).properties;
  assert.ok(!logged.hs_email_text.includes(link[1]) && !(logged.hs_email_html || '').includes(link[1]), 'personal link scrubbed from HubSpot');
  assert.equal(d.outcome, 'accepted'); assert.equal(d.by, 'Megan');
  const days = (new Date(d.holdUntil) - new Date(d.at)) / 864e5;
  assert.equal(Math.round(days), 7);
  assert.equal(up.crm.deals.get('900').properties.dealstage, 'p9c', 'Accepted → Interview Complete');
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Accepted.*Megan/);
  assert.equal((await call({ id, outcome: 'accepted', by: 'Megan' })).status, 409, 'already accepted');
});

await t('accept is refused (nothing stored, no email) without a program start date', async () => {
  up.crm.programs.push({ id: 'P0', properties: { pacific_discovery_program: 'South America Semester' } });
  const id = await insertApp('nodate@x.org', { record: 'P0' });
  const before = mails.length;
  const r = await call({ id, outcome: 'accepted', by: 'Megan' });
  assert.equal(r.status, 409); assert.match(r.body.error, /Program Start Date/);
  assert.equal(await decision(id), null);
  assert.equal(mails.length, before);
});

await t('extend hold: more days from today, never shorter; only for an accepted application', async () => {
  const id = await insertApp('hold@x.org');
  const ext = (body) => service(new Request('https://apply.example.org/api/service/extend-hold', { method: 'POST', headers: { 'x-apply-key': 'svc', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await ext({ id, days: 7, by: 'Megan' })).status, 409, 'not accepted yet');
  await call({ id, outcome: 'accepted', by: 'Megan' });
  const first = (await decision(id)).holdUntil;
  const r = await ext({ id, days: 14, by: 'Megan' });
  assert.equal(r.status, 200);
  const d = await decision(id);
  assert.equal(Math.round((new Date(d.holdUntil) - Date.now()) / 864e5), 14);
  assert.equal(d.extended[0].by, 'Megan');
  const en = (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [id])).rows[0].enrolment;
  assert.equal(en.offer.holdUntil, d.holdUntil, 'the acceptance page sees it');
  await ext({ id, days: 2, by: 'Megan' });
  assert.equal((await decision(id)).holdUntil, d.holdUntil, 'a shorter extension never cuts the hold');
  assert.ok(new Date(d.holdUntil) > new Date(first));
});

await t('accept never drags a deal backwards (e.g. already at Deposit Paid/Customer)', async () => {
  up.crm.deals.get('900').properties.dealstage = 'p9d';
  const id = await insertApp('ahead@x.org');
  const r = await call({ id, outcome: 'accepted', by: 'Megan' });
  assert.equal(r.status, 200);
  assert.equal(up.crm.deals.get('900').properties.dealstage, 'p9d');
  assert.equal((await decision(id)).hubspot.stage, null);
  up.crm.deals.get('900').properties.dealstage = 'p9';
});

await t('decline: refunds the fee (once), emails student + parent, deal → Declined', async () => {
  const id = await insertApp('dec@x.org');
  const before = mails.length;
  const r = await call({ id, outcome: 'declined', by: 'Megan', message: 'We would love to see you apply for Fall.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ref = up.stripe.refunds.at(-1);
  assert.equal(ref.form.get('payment_intent'), 'pi_dec'); assert.equal(ref.form.get('amount'), null, 'full amount');
  assert.equal(ref.key, `pd-apply-decline-${id}`);
  const d = await decision(id);
  assert.equal(d.refund.amount, 25875); assert.equal(d.refund.status, 'succeeded');
  const m = mails.at(-1);
  assert.equal(mails.length, before + 1);
  assert.equal(m.to, 'dec@x.org, parent.dec@x.org');
  assert.equal(m.subject, 'Your Pacific Discovery application');
  assert.match(m.text, /not able to offer you a place/);
  assert.match(m.text, /We would love to see you apply for Fall\./);
  assert.match(m.text, /refunded your application fee of \$258\.75/);
  assert.ok(!/\{\w+\}/.test(m.text), 'no unfilled placeholders');
  assert.ok(!/advisor/i.test(m.text), 'no advisor sales block on a decline');
  assert.equal(d.email.to.length, 2); assert.ok(d.email.hubspot.id, 'logged in HubSpot');
  assert.equal(up.crm.deals.get('900').properties.dealstage, 'p9l', 'Declined → Closed Lost');
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Not accepted.*refunded: \$258\.75/s);
  const again = await call({ id, outcome: 'declined', by: 'Megan' });
  assert.equal(again.status, 409);
  assert.equal(up.stripe.refunds.filter((x) => x.key === `pd-apply-decline-${id}`).length, 1);
  assert.equal((await call({ id, outcome: 'accepted', by: 'Megan' })).status, 409, 'a decline is final here');
});

await t('decline after acceptance: no refund by default (fee is non-refundable), kept in history', async () => {
  const id = await insertApp('late@x.org');
  await call({ id, outcome: 'accepted', by: 'Megan' });
  const refunds = up.stripe.refunds.length;
  const r = await call({ id, outcome: 'declined', by: 'Megan' });
  assert.equal(r.status, 200);
  assert.equal(up.stripe.refunds.length, refunds, 'no refund');
  const d = await decision(id);
  assert.equal(d.refund, undefined);
  assert.equal(d.history[0].outcome, 'accepted');
  assert.ok(!/refunded/.test(mails.at(-1).text));
});

await t('decline with refund: if Stripe refuses, nothing changes and nobody is emailed', async () => {
  const id = await insertApp('fail@x.org');
  const before = mails.length;
  up.stripe.refundFail = 'Charge has already been refunded.';
  const r = await call({ id, outcome: 'declined', by: 'Megan' });
  up.stripe.refundFail = null;
  assert.ok(r.status >= 400);
  assert.equal(await decision(id), null);
  assert.equal(mails.length, before);
  const ok = await call({ id, outcome: 'declined', by: 'Megan' });
  assert.equal(ok.status, 200, 'and it can be retried');
});

await t('decline without refund when admissions unticks it', async () => {
  const id = await insertApp('norefund@x.org');
  const refunds = up.stripe.refunds.length;
  const r = await call({ id, outcome: 'declined', by: 'Megan', refund: false });
  assert.equal(r.status, 200);
  assert.equal(up.stripe.refunds.length, refunds);
});

await t('a double click makes one decision and one email', async () => {
  const id = await insertApp('dbl@x.org');
  const before = mails.length;
  const quiet = { error() {} };
  const results = await Promise.allSettled([
    decide(id, { outcome: 'declined', by: 'A' }, { schema, log: quiet }),
    decide(id, { outcome: 'declined', by: 'B' }, { schema, log: quiet }),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(mails.length, before + 1);
});

up.restore();
await pool.end();
console.log(`decisions: ${n} passed`);
