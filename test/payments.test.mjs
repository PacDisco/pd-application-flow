// After the deposit (stage 4b): automatic instalments, notices, retries,
// paying / updating from the acceptance page, balance + deposit reminders,
// withdrawals. Real handlers, local Postgres, fake HubSpot / Stripe.
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
const { decide, extendHold } = await import('../netlify/functions/_lib/decisions.mjs');
const PAY = await import('../netlify/functions/_lib/payments.mjs');
const accept = (await import('../netlify/functions/accept.mjs')).default;
const webhook = (await import('../netlify/functions/stripe-webhook.mjs')).default;
const service = (await import('../netlify/functions/service.mjs')).default;
const quiet = { error() {}, warn() {} };
const cfg = { autoCharge: true, depositReminders: true, tz: 'America/Denver' };

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const at = (day, hour = 18) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`); // noon-ish in Denver
const addDays = (d, k) => new Date(new Date(`${d}T12:00:00Z`).getTime() + k * 864e5).toISOString().slice(0, 10);
const run = (now) => PAY.runPayments({ schema, now, log: quiet });
const enrolment = async (id) => (await pool.query('SELECT enrolment FROM applications WHERE id = $1', [id])).rows[0].enrolment;
const chargesFor = (id) => (up.stripe.charges || []).filter((c) => c.meta.application_id === id).length;
const status = async (id) => (await enrolment(id)).schedule.map((p) => p.status);
async function hook(type, object) {
  const payload = JSON.stringify({ type, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${payload}`).digest('hex');
  return (await webhook(new Request('https://apply.example.org/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, body: payload }))).json();
}
const api = async (path, body) => {
  const res = await accept(new Request(`https://apply.example.org/api/accept/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined));
  return { status: res.status, body: await res.json() };
};
const svc = async (route, body) => {
  const res = await service(new Request(`https://apply.example.org/api/service/${route}`, { method: 'POST', headers: { 'x-apply-key': 'svc', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

let deals = 700;
async function accepted(email) {
  // Each test's runs only see its own applicant (earlier ones are parked).
  await pool.query(`UPDATE applications SET status = 'withdrawn'`);
  const deal = String(deals++);
  up.crm.deals.set(deal, { id: deal, properties: { pipeline: '74958084', dealstage: 'f9i' } });
  const answers = { preferredName: 'Sam', parent1Email: `parent.${email}` };
  const [{ id }] = (await pool.query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, interview_at, paid_at, payment, hubspot_contact_id, hubspot_deal_id, sync)
     VALUES ($1,$2,'Sam','Lee','South America Gap Semester','Fall 2027','paid',$3, now(), now(), now(), now(), $4, '501', $5, $6) RETURNING id`,
    [`h-${email}`, email, JSON.stringify(answers), JSON.stringify({ reference: 'pi_fee', base: 250, total: 258.75, currency: 'usd' }), deal,
      JSON.stringify({ hsProgram: { record: { id: 'P5' } } })])).rows;
  await decide(id, { outcome: 'accepted', by: 'Megan' }, { schema, log: quiet });
  const token = /\/accept\?token=([\w-]+)/.exec(mails.at(-1).text)[1];
  return { id, token, deal };
}
/** Accepted + deposit paid on `plan` by `method`. */
async function enrolled(email, plan = 'monthly', method = 'card') {
  const a = await accepted(email);
  const r = await api('checkout', { token: a.token, plan, method, agree: true });
  const s = up.stripe.sessions.get(r.body.url.split('/').pop());
  Object.assign(s, { status: 'complete', payment_status: 'paid' });
  await api(`offer?token=${a.token}&session_id=${s.id}`);
  const e = await enrolment(a.id);
  assert.equal(e.deposit.status, 'paid');
  return { ...a, e };
}

// ── pure ───────────────────────────────────────────────────────────────────
await t('itemAction: notice 3 days before, charge on the day, paused / off / retry timing, stuck charge', () => {
  const item = { due: '2026-12-01', amount: 1625, kind: 'instalment', status: 'scheduled' };
  const e = {};
  assert.equal(PAY.itemAction(item, e, at('2026-11-27'), cfg).action, 'none');
  assert.equal(PAY.itemAction(item, e, at('2026-11-28'), cfg).action, 'notice');
  assert.equal(PAY.itemAction({ ...item, noticeAt: 'x' }, e, at('2026-11-29'), cfg).action, 'none');
  assert.equal(PAY.itemAction(item, e, at('2026-12-01', 8), cfg).action, 'charge', '1am Denver on the due day');
  assert.equal(PAY.itemAction(item, e, at('2026-12-01', 6), cfg).action, 'notice', 'still Nov 30 in Denver');
  assert.equal(PAY.itemAction(item, { paused: {} }, at('2026-12-02'), cfg).action, 'none');
  assert.equal(PAY.itemAction(item, e, at('2026-12-02'), { ...cfg, autoCharge: false }).action, 'none');
  assert.equal(PAY.itemAction(item, { withdrawn: {} }, at('2026-12-02'), cfg).action, 'none');
  const failed = { ...item, status: 'failed', attempts: 1, nextAttemptAt: '2026-12-04T18:00:00Z' };
  assert.equal(PAY.itemAction(failed, e, at('2026-12-04', 17), cfg).action, 'none');
  assert.equal(PAY.itemAction(failed, e, at('2026-12-04', 18), cfg).action, 'charge');
  assert.equal(PAY.itemAction({ ...failed, payingUntil: '2026-12-04T19:00:00Z' }, e, at('2026-12-04', 18), cfg).action, 'none', 'paying on the page');
  assert.equal(PAY.itemAction({ ...item, status: 'needs_admissions' }, e, at('2027-01-01'), cfg).action, 'none');
  assert.equal(PAY.itemAction({ ...item, status: 'charging', chargingAt: '2026-12-01T18:00:00Z' }, e, at('2026-12-01', 18), cfg).action, 'none');
  assert.equal(PAY.itemAction({ ...item, status: 'charging', chargingAt: '2026-12-01T18:00:00Z' }, e, at('2026-12-01', 19), cfg).action, 'charge', 'stuck > 30 min');
});

await t('itemAction: balance-later reminders at 14 and 3 days (no burst), then overdue', () => {
  const bal = { due: '2027-06-11', amount: 13000, kind: 'balance', manual: true, status: 'due' };
  assert.equal(PAY.itemAction(bal, {}, at('2027-05-27'), cfg).action, 'none');
  assert.deepEqual(PAY.itemAction(bal, {}, at('2027-05-28'), cfg), { action: 'remind', stage: 14 });
  assert.equal(PAY.itemAction({ ...bal, reminded: [14] }, {}, at('2027-06-01'), cfg).action, 'none');
  assert.deepEqual(PAY.itemAction({ ...bal, reminded: [14] }, {}, at('2027-06-08'), cfg), { action: 'remind', stage: 3 });
  assert.deepEqual(PAY.itemAction(bal, {}, at('2027-06-09'), cfg), { action: 'remind', stage: 3 }, 'missed the 14-day one: only the latest');
  assert.equal(PAY.itemAction({ ...bal, reminded: [14, 3] }, {}, at('2027-06-11'), cfg).action, 'none');
  assert.equal(PAY.itemAction({ ...bal, reminded: [14, 3] }, {}, at('2027-06-12'), cfg).action, 'overdue');
  assert.equal(PAY.itemAction({ ...bal, overdueAt: 'x' }, {}, at('2027-06-20'), cfg).action, 'none');
});

await t('depositAction: reminders at 5, 2, 1 days left (per hold), then hold passed once', () => {
  const acceptedAt = '2026-11-01T18:00:00Z'; const holdUntil = '2026-11-08T18:00:00Z';
  const d = { outcome: 'accepted', at: acceptedAt, holdUntil };
  const e = { offer: { holdUntil } };
  assert.equal(PAY.depositAction(e, d, at('2026-11-02', 17), cfg).action, 'none');
  assert.deepEqual(PAY.depositAction(e, d, at('2026-11-03'), cfg), { action: 'remind', stage: 5, holdUntil });
  const after5 = { ...e, depositReminded: { [`${holdUntil}|5`]: '2026-11-03T18:00:00Z' } };
  assert.equal(PAY.depositAction(after5, d, at('2026-11-05'), cfg).action, 'none');
  assert.deepEqual(PAY.depositAction(after5, d, at('2026-11-06'), cfg), { action: 'remind', stage: 2, holdUntil });
  assert.equal(PAY.depositAction({ ...e, deposit: { status: 'processing' } }, d, at('2026-11-06'), cfg).action, 'none');
  assert.deepEqual(PAY.depositAction(e, d, at('2026-11-09'), cfg), { action: 'expired', holdUntil });
  assert.equal(PAY.depositAction({ ...e, holdExpired: { holdUntil } }, d, at('2026-11-09'), cfg).action, 'none');
  const ext = '2026-11-15T18:00:00Z';
  assert.deepEqual(PAY.depositAction({ ...after5, holdExpired: { holdUntil } }, { ...d, holdUntil: ext }, at('2026-11-10'), cfg), { action: 'remind', stage: 5, holdUntil: ext }, 'an extension starts the reminders again');
  assert.equal(PAY.depositAction(e, d, at('2026-11-03'), { ...cfg, depositReminders: false }).action, 'none');
});

// ── integration ────────────────────────────────────────────────────────────
await t('monthly by card: notice 3 days before → charged on the day (+3.5%) → receipt, HubSpot payment_N + note; once only', async () => {
  const { id, deal, e } = await enrolled('card@x.org');
  const first = e.schedule[1];
  assert.equal(first.status, 'scheduled');
  let before = mails.length;
  await run(at(addDays(first.due, -3)));
  assert.equal(mails.length, before + 1);
  const notice = mails.at(-1);
  assert.equal(notice.to, 'card@x.org, parent.card@x.org');
  assert.match(notice.subject, /next payment/i);
  assert.match(notice.text, /\$1,681\.88 .* card on/);
  assert.match(notice.text, /Remaining tuition: \$13,000/);
  assert.match(notice.text, /\/accept\?token=/);
  const logged = up.crm.emails.at(-1).properties;
  assert.ok(!/accept\?token=\w/.test(logged.hs_email_text), 'personal link not in HubSpot');
  await run(at(addDays(first.due, -2)));
  assert.equal(mails.length, before + 1, 'one notice');

  before = mails.length;
  const charges = (up.stripe.charges || []).length;
  await Promise.all([run(at(first.due)), run(at(first.due))]);
  assert.equal(up.stripe.charges.length, charges + 1, 'two overlapping runs → one charge');
  const c = up.stripe.charges.at(-1);
  assert.equal(c.form.get('amount'), '168188');
  assert.equal(c.form.get('off_session'), 'true');
  assert.equal(c.form.get('payment_method'), e.stripe.paymentMethod);
  assert.equal(c.meta.payment_kind, 'instalment'); assert.equal(c.meta.item, '1');
  const item = (await enrolment(id)).schedule[1];
  assert.equal(item.status, 'paid'); assert.equal(item.total, 1681.88); assert.equal(item.fee, 56.88);
  assert.equal(mails.length, before + 1);
  assert.match(mails.at(-1).subject, /Payment received/);
  assert.match(mails.at(-1).text, /Remaining tuition: \$11,375/);
  const props = up.crm.deals.get(deal).properties;
  assert.ok(Object.values(props).some((v) => /^1625, pi_inst_/.test(String(v))), 'payment_N on the deal');
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Tuition payment received.*1 of 8/s);
  // the webhook for the same charge changes nothing
  await hook('payment_intent.succeeded', { id: c.id, amount: 168188, amount_received: 168188, metadata: c.meta });
  assert.equal(mails.length, before + 1);
  await run(at(addDays(first.due, 1)));
  assert.equal(mails.length, before + 1, 'nothing else due');
});

let declined;
await t('declined: retried after 3 and 4 more days, then admissions; family emailed each time', async () => {
  declined = await enrolled('decline@x.org');
  const due = declined.e.schedule[1].due;
  up.stripe.chargeOutcome = 'insufficient_funds';
  let before = mails.length;
  await run(at(due));
  let item = (await enrolment(declined.id)).schedule[1];
  assert.equal(item.status, 'failed'); assert.equal(item.attempts, 1); assert.equal(item.lastError.reason, 'insufficient_funds');
  assert.equal(item.nextAttemptAt.slice(0, 10), addDays(due, 3));
  assert.match(mails.at(-1).subject, /Action needed/);
  assert.match(mails.at(-1).text, /didn't go through \(insufficient funds\)/);
  assert.match(mails.at(-1).text, /We'll try again on/);
  await run(at(addDays(due, 2)));
  assert.equal((await enrolment(declined.id)).schedule[1].attempts, 1, 'not before the retry date');
  await run(at(addDays(due, 3), 19));
  item = (await enrolment(declined.id)).schedule[1];
  assert.equal(item.attempts, 2); assert.equal(item.nextAttemptAt.slice(0, 10), addDays(due, 7));
  before = mails.length;
  await run(at(addDays(due, 7), 20));
  item = (await enrolment(declined.id)).schedule[1];
  assert.equal(item.status, 'needs_admissions'); assert.equal(item.attempts, 3);
  const sent = mails.slice(before);
  assert.equal(sent.length, 2);
  assert.match(sent.find((m) => m.to.includes('decline@x.org')).text, /won't try this payment again automatically/);
  assert.match(sent.find((m) => m.to === 'admissions@pacificdiscovery.org').subject, /Tuition payment failed: Sam Lee/);
  const charges = chargesFor(declined.id);
  await run(at(addDays(due, 20)));
  assert.equal(chargesFor(declined.id), charges, 'no more automatic tries');
  assert.equal((await enrolment(declined.id)).schedule[2].status, 'scheduled', 'the next instalment is still on');
  up.stripe.chargeOutcome = null;
  // admissions retries once the family has sorted it
  assert.equal((await svc('payment-retry', { id: declined.id, item: 1, by: 'Megan' })).status, 200);
  await run(at(addDays(due, 20), 20));
  assert.equal((await enrolment(declined.id)).schedule[1].status, 'paid');
});

await t('update payment method from the page: new bank account saved; failed payments retried with it', async () => {
  const { id, token, e } = await enrolled('switch@x.org');
  const due = e.schedule[1].due;
  up.stripe.chargeOutcome = 'decline';
  await run(at(due));
  up.stripe.chargeOutcome = null;
  assert.equal((await enrolment(id)).schedule[1].status, 'failed');
  const r = await api('update-method', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = up.stripe.sessions.get(r.body.url.split('/').pop());
  assert.equal(s.mode, 'setup');
  assert.deepEqual(s.form.getAll('payment_method_types[]'), ['card', 'us_bank_account']);
  Object.assign(s, { status: 'complete', setup_intent: 'seti_1' });
  up.stripe.setupPm = 'pm_bank'; up.stripe.setupPmType = 'us_bank_account';
  await api(`offer?token=${token}&session_id=${s.id}`);
  const after = await enrolment(id);
  assert.equal(after.stripe.paymentMethod, 'pm_bank'); assert.equal(after.choice.method, 'ach'); assert.equal(after.choice.rate, 0.01);
  assert.equal(after.schedule[1].status, 'failed');
  assert.ok(new Date(after.schedule[1].nextAttemptAt) <= new Date());
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Payment method updated.*bank account/);
  // next run: the bank payment starts clearing; the webhook confirms it later
  up.stripe.chargeOutcome = 'processing';
  await run(new Date(Date.now() + 60e3));
  up.stripe.chargeOutcome = null;
  const c = up.stripe.charges.at(-1);
  assert.equal(c.form.get('payment_method'), 'pm_bank'); assert.equal(c.form.get('payment_method_types[]'), 'us_bank_account');
  assert.equal(c.form.get('amount'), '164125', '+1% bank fee');
  assert.equal((await enrolment(id)).schedule[1].status, 'processing');
  const before = mails.length;
  await hook('payment_intent.succeeded', { id: c.id, amount: 164125, amount_received: 164125, metadata: c.meta });
  await hook('payment_intent.succeeded', { id: c.id, amount: 164125, amount_received: 164125, metadata: c.meta });
  assert.equal((await enrolment(id)).schedule[1].status, 'paid');
  assert.equal(mails.length, before + 1, 'one receipt');
});

await t('a bank instalment that bounces (webhook) counts as a failed try', async () => {
  const { id, e } = await enrolled('bounce@x.org', 'monthly', 'ach');
  up.stripe.chargeOutcome = 'processing';
  await run(at(e.schedule[1].due));
  up.stripe.chargeOutcome = null;
  const c = up.stripe.charges.at(-1);
  await hook('payment_intent.payment_failed', { id: c.id, metadata: c.meta, last_payment_error: { code: 'insufficient_funds', message: 'R01' } });
  const item = (await enrolment(id)).schedule[1];
  assert.equal(item.status, 'failed'); assert.equal(item.attempts, 1); assert.equal(item.lastError.reason, 'insufficient_funds');
});

await t('pay a failed payment from the page: the automatic retry waits; paid → receipt', async () => {
  const { id, token } = await enrolled('paynow@x.org');
  const due = (await enrolment(id)).schedule[1].due;
  up.stripe.chargeOutcome = 'decline';
  await run(at(due));
  up.stripe.chargeOutcome = null;
  assert.equal((await api('pay-item', { token, index: 2, method: 'card' })).status, 409, 'not open yet');
  const r = await api('pay-item', { token, index: 1, method: 'card' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = up.stripe.sessions.get(r.body.url.split('/').pop());
  assert.equal(s.amount_total, 162500 + 5688);
  assert.ok(s.form.get('expires_at'));
  await svc('payment-retry', { id, item: 1, by: 'Megan' }); // retry due now…
  const charges = chargesFor(id);
  await run(new Date());
  assert.equal(chargesFor(id), charges, '…but not while they are paying at Stripe');
  Object.assign(s, { status: 'complete', payment_status: 'paid' });
  const before = mails.length;
  const view = await api(`offer?token=${token}&session_id=${s.id}`);
  assert.equal((await enrolment(id)).schedule[1].status, 'paid');
  assert.equal(view.body.offer.schedule[1].status, 'paid');
  assert.equal(mails.length, before + 1);
  await hook('checkout.session.completed', s);
  assert.equal(mails.length, before + 1, 'webhook too: once');
});

await t('balance later: reminders 14 and 3 days before, payable from the page, overdue → admissions', async () => {
  const { id, token, e } = await enrolled('later@x.org', 'later');
  const bal = e.schedule[1];
  assert.deepEqual([bal.kind, bal.status, bal.manual], ['balance', 'due', true]);
  let before = mails.length;
  await run(at(addDays(bal.due, -14)));
  assert.match(mails.at(-1).subject, /balance .* is due/);
  assert.match(mails.at(-1).text, /\$13,000/);
  await run(at(addDays(bal.due, -10)));
  assert.equal(mails.length, before + 1);
  await run(at(addDays(bal.due, -3)));
  assert.equal(mails.length, before + 2);
  assert.equal((up.stripe.charges || []).filter((c) => c.meta.application_id === id).length, 0, 'never charged automatically');
  before = mails.length;
  await run(at(addDays(bal.due, 1)));
  assert.match(mails.at(-1).subject, /Tuition balance overdue: Sam Lee/);
  await run(at(addDays(bal.due, 2)));
  assert.equal(mails.length, before + 1, 'once');
  const r = await api('pay-item', { token, index: 1, method: 'ach' });
  const s = up.stripe.sessions.get(r.body.url.split('/').pop());
  assert.equal(s.amount_total, 1300000 + 13000);
  Object.assign(s, { status: 'complete', payment_status: 'unpaid' });
  await hook('checkout.session.completed', s);
  assert.equal((await enrolment(id)).schedule[1].status, 'processing');
  s.payment_status = 'paid';
  await hook('checkout.session.async_payment_succeeded', s);
  assert.equal((await enrolment(id)).schedule[1].status, 'paid');
  assert.match(mails.at(-1).text, /paid in full/);
});

await t('deposit reminders while the place is held; admissions told when the hold passes', async () => {
  const { id } = await accepted('remind@x.org');
  const { decision } = (await pool.query('SELECT decision FROM applications WHERE id = $1', [id])).rows[0];
  const hold = new Date(decision.holdUntil).getTime();
  let before = mails.length;
  await run(new Date(hold - 4.5 * 864e5));
  assert.equal(mails.length, before + 1);
  assert.match(mails.at(-1).subject, /Reminder: confirm your place/);
  assert.match(mails.at(-1).text, /\$2,250 deposit/);
  await run(new Date(hold - 4 * 864e5));
  assert.equal(mails.length, before + 1);
  await run(new Date(hold - 1.5 * 864e5));
  await run(new Date(hold - 0.5 * 864e5));
  assert.equal(mails.length, before + 3);
  before = mails.length;
  await run(new Date(hold + 3600e3));
  await run(new Date(hold + 7200e3));
  assert.equal(mails.length, before + 1);
  assert.match(mails.at(-1).subject, /hold passed: Sam Lee/);
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Hold passed/);
});

await t('withdraw after the deposit: future payments cancelled, what was paid kept, deal → Cancelled, nothing charged after', async () => {
  const { id, deal, token, e } = await enrolled('quit@x.org');
  await run(at(e.schedule[1].due));
  assert.equal((await enrolment(id)).schedule[1].status, 'paid');
  const r = await svc('withdraw', { id, by: 'Megan', reason: 'Changed plans' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kept, 250 + 2250 + 1625);
  assert.equal(r.body.cancelled, 7);
  assert.deepEqual(await status(id), ['paid', 'paid', ...Array(7).fill('cancelled')]);
  assert.equal(up.crm.deals.get(deal).properties.dealstage, 'f9x', 'Cancelled');
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Withdrew.*Changed plans.*\$4,125/s);
  const charges = chargesFor(id);
  await run(at(e.schedule[2].due));
  assert.equal(chargesFor(id), charges);
  assert.equal((await svc('withdraw', { id, by: 'Megan' })).status, 409);
  assert.equal((await api('update-method', { token })).status, 409);
});

await t('paused: no notices or charges until resumed', async () => {
  const { id, e } = await enrolled('pause@x.org');
  await svc('payments-pause', { id, paused: true, by: 'Megan' });
  const charges = chargesFor(id);
  await run(at(e.schedule[1].due));
  assert.equal(chargesFor(id), charges);
  await svc('payments-pause', { id, paused: false, by: 'Megan' });
  await run(at(e.schedule[1].due));
  assert.equal((await enrolment(id)).schedule[1].status, 'paid');
});

await t('pay the rest early: one checkout covers every open payment; automatic ones stop; one receipt', async () => {
  const { id, token, deal, e } = await enrolled('early@x.org');
  await run(at(e.schedule[1].due));
  const r = await api('pay-item', { token, index: 'rest', method: 'card' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = up.stripe.sessions.get(r.body.url.split('/').pop());
  assert.equal(s.amount_total, 1137500 + 39813, '7 × $1,625 + 3.5%');
  assert.equal(s.metadata.items, '2,3,4,5,6,7,8');
  // started again (closed the tab): the first checkout is closed so it can't also be paid
  const again = await api('pay-item', { token, index: 'rest', method: 'card' });
  assert.equal(again.status, 200);
  assert.equal(s.status, 'expired');
  const s2 = up.stripe.sessions.get(again.body.url.split('/').pop());
  Object.assign(s2, { status: 'complete', payment_status: 'paid' });
  // …and once one has been paid, no new checkout
  assert.equal((await api('pay-item', { token, index: 'rest', method: 'card' })).status, 409);
  const before = mails.length;
  await hook('checkout.session.completed', s2);
  await hook('checkout.session.completed', s2);
  assert.deepEqual(await status(id), Array(9).fill('paid'));
  assert.equal(mails.length, before + 1, 'one receipt');
  assert.match(mails.at(-1).text, /paid in full/);
  assert.ok(Object.values(up.crm.deals.get(deal).properties).some((v) => /^11375, /.test(String(v))), 'one payment_N for the lot');
  const charges = chargesFor(id);
  await run(at(e.schedule[2].due));
  assert.equal(chargesFor(id), charges, 'nothing charged after');
  assert.equal((await api(`offer?token=${token}`)).body.offer.rest, 0);
});

await t('admissions marks a bank transfer as paid: it is never charged', async () => {
  const { id, e } = await enrolled('wire@x.org');
  const r = await svc('payment-mark-paid', { id, item: 1, reference: 'Wise 123', by: 'Megan' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.status, 'paid'); assert.equal(r.body.item.method, 'manual'); assert.equal(r.body.item.markedBy, 'Megan');
  await run(at(e.schedule[1].due));
  assert.equal(chargesFor(id), 0);
  assert.match(up.crm.notes.at(-1).properties.hs_note_body, /Marked paid outside Stripe.*Wise 123/);
  assert.equal((await svc('payment-mark-paid', { id, item: 1, by: 'Megan' })).status, 409);
});

await t('student portal: accepted but no deposit yet → "offer" (confirm your place), with the right deposit', async () => {
  const { deal } = await accepted('portaloffer@x.org');
  const res = await service(new Request(`https://apply.example.org/api/service/plan?dealId=${deal}&email=portaloffer@x.org`, { headers: { 'x-apply-key': 'svc' } }));
  const { plan } = await res.json();
  assert.equal(plan.state, 'offer'); assert.equal(plan.deposit, 2250); assert.equal(plan.holdPassed, false);
  assert.equal((await svc('plan-link', { dealId: deal, email: 'portaloffer@x.org' })).status, 200);
  const { id } = (await pool.query(`SELECT id FROM applications WHERE email = 'portaloffer@x.org'`)).rows[0];
  assert.equal((await svc('deposit-mark-paid', { id, reference: 'Wise 7', by: 'Megan' })).status, 200);
  const after = await (await service(new Request(`https://apply.example.org/api/service/plan?dealId=${deal}&email=portaloffer@x.org`, { headers: { 'x-apply-key': 'svc' } }))).json();
  assert.equal(after.plan.state, 'choose'); assert.equal(after.plan.deposit, 2250);
  // no deposit reminders once it's been paid another way
  const before = mails.length;
  await run(new Date(Date.now() + 5.5 * 864e5));
  assert.equal(mails.filter((m, i) => i >= before && m.to.includes('portaloffer')).length, 0);
});

await t('student portal: plan by deal for the student or a parent only; a fresh link on request', async () => {
  const { id, deal } = await enrolled('portal@x.org');
  const get = async (q) => (await (await service(new Request(`https://apply.example.org/api/service/plan?${q}`, { headers: { 'x-apply-key': 'svc' } }))).json());
  const mine = await get(`dealId=${deal}&email=portal@x.org`);
  assert.equal(mine.plan.state, 'plan'); assert.equal(mine.plan.plan, 'monthly'); assert.equal(mine.plan.schedule.length, 9);
  assert.equal(mine.plan.remaining, 13000); assert.equal(mine.plan.next.amount, 1625); assert.equal(mine.plan.automatic, true);
  assert.equal((await get(`dealId=${deal}&email=PARENT.portal@x.org`)).plan.plan, 'monthly', 'a parent, any case');
  assert.equal((await get(`dealId=${deal}&email=someone@else.org`)).plan, null);
  assert.equal((await get(`dealId=999&email=portal@x.org`)).plan, null);
  const link = await svc('plan-link', { dealId: deal, email: 'portal@x.org' });
  assert.match(link.body.url, /^https:\/\/apply\.example\.org\/accept\?token=[\w-]+$/);
  const tok = link.body.url.split('token=')[1];
  assert.equal((await api(`offer?token=${tok}`)).body.offer.state, 'enrolled');
  assert.equal((await svc('plan-link', { dealId: deal, email: 'x@y.org' })).status, 404);
  const noKey = await service(new Request(`https://apply.example.org/api/service/plan?dealId=${deal}&email=portal@x.org`));
  assert.equal(noKey.status, 403);
});

up.restore();
await pool.end();
console.log(`payments: ${n} passed`);
