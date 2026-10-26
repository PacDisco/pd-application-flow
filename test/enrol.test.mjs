// Acceptance page → deposit checkout → place confirmed (stage 4a). Real
// handlers against local Postgres with fake HubSpot / Stripe. Needs
// TEST_PG_URL with MIGRATION-apply.sql, -decisions.sql and -enrolment.sql.
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
const accept = (await import('../netlify/functions/accept.mjs')).default;
const webhook = (await import('../netlify/functions/stripe-webhook.mjs')).default;
const quiet = { error() {}, warn() {} };

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
let deals = 900;
async function acceptedApp(email, { record = 'P5' } = {}) {
  const deal = String(deals++);
  up.crm.deals.set(deal, { id: deal, properties: { pipeline: '74958084', dealstage: 'f9i' } });
  const answers = { preferredName: 'Sam', parent1Email: `parent.${email}`, parent1Name: { first: 'P', last: 'Q' } };
  const [{ id }] = (await pool.query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, interview_at, paid_at, payment, hubspot_contact_id, hubspot_deal_id, sync)
     VALUES ($1,$2,'Sam','Lee','South America Gap Semester','Fall 2027','paid',$3, now(), now(), now(), now(), $4, '501', $5, $6) RETURNING id`,
    [`h-${email}`, email, JSON.stringify(answers), JSON.stringify({ reference: 'pi_fee', base: 250, total: 258.75, currency: 'usd' }), deal,
      JSON.stringify({ hsProgram: { record: { id: record } } })])).rows;
  await decide(id, { outcome: 'accepted', by: 'Megan' }, { schema, log: quiet });
  const token = /\/accept\?token=([\w-]+)/.exec(mails.at(-1).text)[1];
  return { id, token, deal };
}
const offer = async (token, extra = '') => {
  const res = await accept(new Request(`https://apply.example.org/api/accept/offer?token=${token}${extra}`));
  return { status: res.status, body: await res.json() };
};
const checkout = async (body) => {
  const res = await accept(new Request('https://apply.example.org/api/accept/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const sessionOf = (url) => up.stripe.sessions.get(url.split('/').pop());
async function hook(type, session) {
  const payload = JSON.stringify({ type, data: { object: session } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${payload}`).digest('hex');
  const res = await webhook(new Request('https://apply.example.org/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, body: payload }));
  return res.json();
}
const enrolment = async (id) => (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [id])).rows[0].enrolment;

await t('the acceptance link shows their offer: price, start, options, fees, terms', async () => {
  const { token } = await acceptedApp('offer@x.org');
  const r = await offer(token);
  assert.equal(r.status, 200);
  const o = r.body.offer;
  assert.equal(o.state, 'offer');
  assert.equal(o.tuition, 15500); assert.equal(o.paid, 250); assert.equal(o.deposit, 2250); assert.equal(o.start, '2027-09-09');
  assert.equal(o.options[0].key, 'monthly'); assert.equal(o.options[0].primary, true);
  assert.ok(o.options.find((x) => x.key === 'later').quiet);
  assert.deepEqual(o.rates, { card: 0.035, ach: 0.01 });
  assert.equal(o.firstName, 'Sam');
  assert.equal((await offer('nope')).status, 404);
});

await t('checkout: needs terms agreed, a real option and method; charges deposit + fee; saves the method for instalments', async () => {
  const { id, token } = await acceptedApp('pay@x.org');
  assert.equal((await checkout({ token, plan: 'monthly', method: 'card', agree: false })).status, 400);
  assert.equal((await checkout({ token, plan: 'weekly', method: 'card', agree: true })).status, 400);
  assert.equal((await checkout({ token, plan: 'monthly', method: 'cash', agree: true })).status, 400);
  const r = await checkout({ token, plan: 'monthly', method: 'card', agree: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = sessionOf(r.body.url);
  assert.equal(s.amount_total, 225000 + 7875, 'deposit + 3.5%');
  assert.equal(s.form.get('payment_method_types[]'), 'card');
  assert.equal(s.form.get('payment_intent_data[setup_future_usage]'), 'off_session');
  assert.equal(s.metadata.payment_kind, 'deposit'); assert.equal(s.metadata.plan, 'monthly');
  assert.match(s.success_url, /\/accept\?token=.+&paid=1&session_id=\{CHECKOUT_SESSION_ID\}/);
  assert.equal((await enrolment(id)).pending.sessionId, s.id);

  const full = sessionOf((await checkout({ token, plan: 'full', method: 'ach', agree: true })).body.url);
  assert.equal(full.amount_total, 1525000 + 15250, 'balance in full + 1% bank fee');
  assert.equal(full.form.get('payment_method_types[]'), 'us_bank_account');
  assert.equal(full.form.get('payment_intent_data[setup_future_usage]'), null, 'nothing to charge later');
});

await t('card paid → return page confirms: schedule, HubSpot Deposit Paid + payment_1 + note, family + admissions emailed once', async () => {
  const { id, token, deal } = await acceptedApp('card@x.org');
  const s = sessionOf((await checkout({ token, plan: 'monthly', method: 'card', agree: true })).body.url);
  Object.assign(s, { status: 'complete', payment_status: 'paid' });
  const before = mails.length;
  const r = await offer(token, `&session_id=${s.id}`);
  assert.equal(r.body.offer.state, 'enrolled');
  assert.equal(r.body.offer.processing, false);
  const e = await enrolment(id);
  assert.equal(e.deposit.status, 'paid'); assert.equal(e.deposit.amount, 2250); assert.equal(e.deposit.fee, 78.75);
  assert.equal(e.choice.plan, 'monthly'); assert.equal(e.stripe.paymentMethod, `pm_${s.payment_intent}`);
  assert.equal(e.schedule[0].status, 'paid');
  assert.ok(e.schedule.slice(1).every((p) => p.status === 'scheduled' && p.kind === 'instalment'));
  const props = up.crm.deals.get(deal).properties;
  assert.equal(props.dealstage, 'f9d', 'Deposit Paid/Customer');
  assert.ok(Object.keys(props).some((k) => /^payment_\d+$/.test(k) && /2250/.test(props[k])), 'payment slot');
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Place confirmed.*Monthly payments/s);
  const sent = mails.slice(before);
  assert.equal(sent.length, 2);
  const fam = sent.find((m) => m.to.includes('card@x.org'));
  assert.equal(fam.to, 'card@x.org, parent.card@x.org');
  assert.match(fam.subject, /confirmed/);
  assert.match(fam.text, /\$2,328\.75/);
  assert.match(fam.text, /3\.5% processing fee/);
  assert.match(fam.text, /portal\.pacificdiscovery\.org\/login\.html/);
  assert.ok(!/\{\w+\}/.test(fam.text));
  assert.match(sent.find((m) => m !== fam).subject, /^Deposit paid: Sam Lee/);
  assert.ok(e.emails.enrolled.hubspot.id, 'logged in HubSpot');

  // the webhook arrives too: nothing happens twice
  const w = await hook('checkout.session.completed', s);
  assert.equal(w.first, false);
  assert.equal(mails.length, before + 2);
  // and they can't pay again
  assert.equal((await checkout({ token, plan: 'full', method: 'card', agree: true })).status, 409);
});

await t('bank (ACH): processing → no email yet; async success → confirmed once', async () => {
  const { id, token, deal } = await acceptedApp('ach@x.org');
  const s = sessionOf((await checkout({ token, plan: 'two', method: 'ach', agree: true })).body.url);
  Object.assign(s, { status: 'complete', payment_status: 'unpaid' });
  const before = mails.length;
  await hook('checkout.session.completed', s);
  let e = await enrolment(id);
  assert.equal(e.deposit.status, 'processing');
  assert.equal(mails.length, before, 'nobody emailed while the bank payment clears');
  const o = (await offer(token)).body.offer;
  assert.equal(o.state, 'enrolled'); assert.equal(o.processing, true);
  assert.equal(up.crm.deals.get(deal).properties.dealstage, 'f9c', 'still Interview Complete');

  s.payment_status = 'paid';
  assert.equal((await hook('checkout.session.async_payment_succeeded', s)).first, true);
  assert.equal((await hook('checkout.session.async_payment_succeeded', s)).first, false);
  e = await enrolment(id);
  assert.equal(e.deposit.status, 'paid');
  assert.equal(mails.length, before + 2);
  assert.equal(up.crm.deals.get(deal).properties.dealstage, 'f9d');
  assert.match(mails.slice(before).find((m) => m.to.includes('ach@x.org')).text, /1% processing fee is added to each bank account payment/);
});

await t('bank payment bounces → back to the offer to pay again; HubSpot note', async () => {
  const { id, token } = await acceptedApp('bounce@x.org');
  const s = sessionOf((await checkout({ token, plan: 'monthly', method: 'ach', agree: true })).body.url);
  Object.assign(s, { status: 'complete', payment_status: 'unpaid' });
  await hook('checkout.session.completed', s);
  await hook('checkout.session.async_payment_failed', s);
  assert.equal((await enrolment(id)).deposit.status, 'failed');
  assert.equal((await offer(token)).body.offer.state, 'offer');
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /bank payment failed/);
  assert.equal((await checkout({ token, plan: 'monthly', method: 'card', agree: true })).status, 200, 'can pay again');
});

await t('hold passed → page says so and checkout is refused until admissions extends it', async () => {
  const { id, token } = await acceptedApp('late@x.org');
  await pool.query(`UPDATE applications SET decision = jsonb_set(decision, '{holdUntil}', to_jsonb((now() - interval '1 day')::text)),
    enrolment = jsonb_set(enrolment, '{offer,holdUntil}', to_jsonb((now() - interval '1 day')::text)) WHERE id = $1`, [id]);
  assert.equal((await offer(token)).body.offer.state, 'expired');
  const r = await checkout({ token, plan: 'monthly', method: 'card', agree: true });
  assert.equal(r.status, 409); assert.match(r.body.error, /extend/);
  const { extendHold } = await import('../netlify/functions/_lib/decisions.mjs');
  await extendHold(id, { days: 7, by: 'Megan' });
  assert.equal((await offer(token)).body.offer.state, 'offer');
});

await t('declined after acceptance → the page shows no offer', async () => {
  const { id, token } = await acceptedApp('gone@x.org');
  await decide(id, { outcome: 'declined', by: 'Megan' }, { schema, log: quiet });
  assert.equal((await offer(token)).body.offer.state, 'declined');
  assert.equal((await checkout({ token, plan: 'monthly', method: 'card', agree: true })).status, 409);
});

await t('acceptance email adapts to how close the start is (under 75 days → pay in full)', async () => {
  up.crm.programs.push({ id: 'PSOON', properties: { pacific_discovery_program: 'South America Semester', program_start_date: new Date(Date.now() + 50 * 864e5).toISOString().slice(0, 10) } });
  const { token } = await acceptedApp('soon@x.org', { record: 'PSOON' });
  assert.match(mails.at(-1).text, /less than 75 days, the remaining tuition of \$15,250 is due/);
  const o = (await offer(token)).body.offer;
  assert.deepEqual(o.options.map((x) => x.key), ['full']);
});

up.restore();
await pool.end();
console.log(`enrol: ${n} passed`);
