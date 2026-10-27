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
async function acceptedApp(email, { record = 'P5', paid = true } = {}) {
  const deal = String(deals++);
  up.crm.deals.set(deal, { id: deal, properties: { pipeline: '74958084', dealstage: 'f9i' } });
  const answers = { preferredName: 'Sam', parent1Email: `parent.${email}`, parent1Name: { first: 'P', last: 'Q' } };
  const [{ id }] = (await pool.query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, interview_at, paid_at, payment, hubspot_contact_id, hubspot_deal_id, sync)
     VALUES ($1,$2,'Sam','Lee','South America Gap Semester','Fall 2027',$7,$3, now(), now(), now(), $8, $4, '501', $5, $6) RETURNING id`,
    [`h-${email}`, email, JSON.stringify(answers), paid ? JSON.stringify({ reference: 'pi_fee', base: 250, total: 258.75, currency: 'usd' }) : null, deal,
      JSON.stringify({ hsProgram: { record: { id: record } } }), paid ? 'paid' : 'interview', paid ? new Date() : null])).rows;
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

await t('accepted before paying the fee: $2,500 deposit (fee included); the fee button goes to the acceptance page; paying the fee later makes it $2,250', async () => {
  const { id, token } = await acceptedApp('nofee@x.org', { paid: false });
  let o = (await offer(token)).body.offer;
  assert.equal(o.state, 'offer'); assert.equal(o.paid, 0); assert.equal(o.deposit, 2500);
  assert.equal(o.balance, 15500 - 2500);
  assert.equal(o.options[0].payments[0].amount, 2500);
  const r = await checkout({ token, plan: 'monthly', method: 'card', agree: true });
  assert.equal(sessionOf(r.body.url).amount_total, 250000 + 8750);
  // the old "pay application fee" button
  const apply = (await import('../netlify/functions/apply.mjs')).default;
  const res = await apply(new Request('https://apply.example.org/api/apply/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), { ip: '1.1.1.1' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.url, `https://apply.example.org/accept?token=${token}`);
  // fee paid some other way after all → deposit back to $2,250
  await pool.query(`UPDATE applications SET paid_at = now(), payment = '{"base":250,"reference":"pi_late"}' WHERE id = $1`, [id]);
  o = (await offer(token)).body.offer;
  assert.equal(o.paid, 250); assert.equal(o.deposit, 2250);
});

await t('pay-in-full discount (semester $500): fixed at acceptance, charged on "full" only, deal amount reduced, emails say so', async () => {
  schema.settings.payInFull = { enabled: true, semester: 500, mini: 250, summer: 0 };
  const { id, token, deal } = await acceptedApp('payfull@x.org');
  delete schema.settings.payInFull;
  assert.match(mails.at(-1).text, /Pay in full and save \$500\./);
  const o = (await offer(token)).body.offer;
  const full = o.options.find((x) => x.key === 'full');
  assert.equal(full.discount, 500); assert.equal(full.payments[0].amount, 15250 - 500);
  assert.equal(o.options.find((x) => x.key === 'monthly').discount, undefined);
  const r = await checkout({ token, plan: 'full', method: 'ach', agree: true });
  const s = sessionOf(r.body.url);
  assert.equal(s.amount_total, 1475000 + 14750, '$14,750 + 1% bank fee');
  assert.match(s.form.get('line_items[0][price_data][product_data][name]'), /\$500 pay-in-full discount/);
  Object.assign(s, { status: 'complete', payment_status: 'paid' });
  const before = mails.length;
  await offer(token, `&session_id=${s.id}`);
  const e = (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [id])).rows[0].enrolment;
  assert.equal(e.deposit.discount, 500);
  assert.equal(up.crm.deals.get(deal).properties.amount, '15000', 'deal amount = tuition − discount');
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /\$500 pay-in-full discount/);
  assert.match(mails.slice(before).find((m) => m.to.includes('payfull@x.org')).text, /includes your \$500 pay-in-full discount/);
});

await t('two-instalment discount: off the final payment, deal amount reduced, email says so', async () => {
  schema.settings.discounts = { enabled: true, full: { semester: 500 }, two: { semester: 250, mini: 100 } };
  const { id, token, deal } = await acceptedApp('twodisc@x.org');
  delete schema.settings.discounts;
  assert.match(mails.at(-1).text, /Pay in full and save \$500, or pay in two instalments and save \$250\./);
  const o = (await offer(token)).body.offer;
  const two = o.options.find((x) => x.key === 'two');
  assert.equal(two.discount, 250); assert.deepEqual(two.payments.map((p) => p.amount), [2250, 6500, 6250]);
  const r = await checkout({ token, plan: 'two', method: 'card', agree: true });
  const s = sessionOf(r.body.url);
  assert.equal(s.amount_total, 225000 + 7875, 'deposit today is unchanged');
  Object.assign(s, { status: 'complete', payment_status: 'paid' });
  const before = mails.length;
  await offer(token, `&session_id=${s.id}`);
  const e = (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [id])).rows[0].enrolment;
  assert.equal(e.schedule.at(-1).amount, 6250); assert.equal(e.deposit.discount, 250); assert.equal(e.deposit.discountPlan, 'two');
  assert.equal(up.crm.deals.get(deal).properties.amount, '15250');
  const fam = mails.slice(before).find((m) => m.to.includes('twodisc@x.org'));
  assert.match(fam.text, /\$250 two-instalment discount has been taken off your final payment/);
  assert.ok(!/pay-in-full discount/.test(fam.text));
});

await t('discounts end 60 days before the start', async () => {
  schema.settings.discounts = { enabled: true, full: { semester: 500 }, two: { semester: 250 } };
  up.crm.programs.push({ id: 'P55', properties: { pacific_discovery_program: 'South America Semester', program_start_date: new Date(Date.now() + 55 * 864e5).toISOString().slice(0, 10) } });
  const { token } = await acceptedApp('late60@x.org', { record: 'P55' });
  delete schema.settings.discounts;
  assert.match(mails.at(-1).text, /remaining tuition of \$15,250 is due/);
  assert.ok(!/save/.test(mails.at(-1).text));
  const o = (await offer(token)).body.offer;
  assert.equal(o.options[0].discount, undefined);
});

await t('a discount switched on after acceptance still shows (the better of the two applies)', async () => {
  const { token } = await acceptedApp('after@x.org');
  assert.equal((await offer(token)).body.offer.options.find((x) => x.key === 'full').discount, undefined);
  const pub = (await pool.query(`SELECT published FROM apply_forms LIMIT 1`)).rows[0].published;
  pub.settings = { ...(pub.settings || {}), discounts: { enabled: true, full: { semester: 400 }, two: { semester: 150 } } };
  await pool.query(`UPDATE apply_forms SET published = $1`, [JSON.stringify(pub)]);
  const db = await import('../netlify/functions/_lib/db.mjs'); db.__clearSchemaCache?.();
  const o = (await offer(token)).body.offer;
  assert.equal(o.options.find((x) => x.key === 'full').discount, 400);
  assert.equal(o.options.find((x) => x.key === 'two').discount, 150);
  delete pub.settings.discounts;
  await pool.query(`UPDATE apply_forms SET published = $1`, [JSON.stringify(pub)]);
  db.__clearSchemaCache?.();
});

await t('deposit paid another way: admissions marks it → family emailed to choose a plan; monthly saves a card (nothing charged), schedule starts with the deposit', async () => {
  const PAY = await import('../netlify/functions/_lib/payments.mjs');
  const { id, token, deal } = await acceptedApp('wired@x.org');
  const before = mails.length;
  const r = await PAY.markDepositPaid(id, { reference: 'Wise 42', by: 'Megan' }, schema);
  assert.equal(r.amount, 2250);
  assert.equal(up.crm.deals.get(deal).properties.dealstage, 'f9d', 'Deposit Paid/Customer');
  const m = mails.at(-1); assert.equal(mails.length, before + 1);
  assert.equal(m.to, 'wired@x.org, parent.wired@x.org');
  assert.match(m.text, /received your \$2,250 deposit/); assert.match(m.text, /\/accept\?token=/);
  await assert.rejects(PAY.markDepositPaid(id, { by: 'Megan' }, schema), /already recorded/);
  const o = (await offer(token)).body.offer;
  assert.equal(o.state, 'offer'); assert.equal(o.prepaid, 2250); assert.equal(o.deposit, 0); assert.equal(o.balance, 13000);
  const monthly = o.options.find((x) => x.key === 'monthly');
  assert.equal(monthly.payments[0].amount, 0);
  assert.equal(monthly.payments.slice(1).reduce((a, p) => a + p.amount, 0), 13000);
  const c = await checkout({ token, plan: 'monthly', method: 'card', agree: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const s = sessionOf(c.body.url);
  assert.equal(s.mode, 'setup', 'saves a card, charges nothing');
  Object.assign(s, { status: 'complete', setup_intent: 'seti_9' });
  up.stripe.setupPm = 'pm_saved'; up.stripe.setupPmType = 'card';
  const v = (await offer(token, `&session_id=${s.id}`)).body.offer;
  assert.equal(v.state, 'enrolled');
  const e = (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [id])).rows[0].enrolment;
  assert.deepEqual([e.schedule[0].kind, e.schedule[0].amount, e.schedule[0].status, e.schedule[0].reference], ['deposit', 2250, 'paid', 'Wise 42']);
  assert.ok(e.schedule.slice(1).every((p) => p.status === 'scheduled'));
  assert.equal(e.stripe.paymentMethod, 'pm_saved'); assert.equal(e.deposit.outside, true); assert.equal(e.choice.plan, 'monthly');
  assert.ok(!Object.values(up.crm.deals.get(deal).properties).some((x) => /^2250, /.test(String(x))), 'deposit not logged twice on the deal');
});

await t('deposit paid another way: "balance later" needs no Stripe; "full" charges just the rest', async () => {
  const PAY = await import('../netlify/functions/_lib/payments.mjs');
  const a = await acceptedApp('wired2@x.org');
  await PAY.markDepositPaid(a.id, { amount: 2250, by: 'Megan' }, schema);
  const r = await checkout({ token: a.token, plan: 'later', method: 'card', agree: true });
  assert.equal(r.status, 200); assert.match(r.body.url, /\/accept\?token=.*&paid=1$/);
  const e = (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [a.id])).rows[0].enrolment;
  assert.equal(e.deposit.status, 'paid'); assert.deepEqual(e.schedule.map((p) => p.status), ['paid', 'due']);
  const b = await acceptedApp('wired3@x.org');
  await PAY.markDepositPaid(b.id, { amount: 2250, by: 'Megan' }, schema);
  const f = sessionOf((await checkout({ token: b.token, plan: 'full', method: 'card', agree: true })).body.url);
  assert.equal(f.mode, 'payment'); assert.equal(f.amount_total, 1300000 + 45500);
});

await t('pay-in-full discount by program type; off → none', async () => {
  const E = await import('../netlify/functions/_lib/enrol.mjs');
  const st = { settings: { payInFull: { enabled: true, semester: 500, mini: 250, summer: 0 } }, programs: schema.programs };
  assert.deepEqual(E.planDiscounts({ settings: { discounts: { enabled: true, full: { mini: 250 }, two: { mini: 100 } } }, programs: schema.programs }, { program: 'Hawaii Mini Semester' }), { full: 250, two: 100 });
  assert.equal(E.payInFullDiscount(st, { program: 'South America Gap Semester' }), 500);
  assert.equal(E.payInFullDiscount(st, { program: 'Hawaii Mini Semester' }), 250);
  assert.equal(E.payInFullDiscount(st, { program: 'Bali Summer Program' }), 0);
  assert.equal(E.payInFullDiscount({ ...st, settings: { payInFull: { ...st.settings.payInFull, enabled: false } } }, { program: 'South America Gap Semester' }), 0);
});

up.restore();
await pool.end();
console.log(`enrol: ${n} passed`);
