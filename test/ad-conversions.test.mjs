// node test/ad-conversions.test.mjs — deposit tracking + Google Ads offline feed (no services needed)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as G from '../netlify/functions/_lib/google-offline.mjs';
import * as T from '../netlify/functions/_lib/tracking.mjs';
import feed from '../netlify/functions/google-ads-conversions.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const now = new Date('2026-11-25T12:00:00Z');
const GCLID = 'Cj0KCQiA_test_gclid_123';

const app = (over = {}) => ({
  id: 'a1', email: 'Kid@Example.com', step2_at: '2026-11-10T10:00:00Z', paid_at: '2026-11-11T10:00:00Z', payment: { base: 250 },
  deal_amount: '15500',
  attribution: { first: { ts: '2026-11-01', utm_source: 'google' }, last: { ts: '2026-11-09', gclid: GCLID } },
  enrolment: { offer: { tuition: 15500 }, deposit: { status: 'paid', amount: 2250, paidAt: '2026-11-20T09:30:00Z', reference: 'pi_1' } },
  ...over,
});

await t('names: only known events, exact action names', () => {
  assert.deepEqual(G.parseNames('deposit_paid=PD Deposit, application_submit = PD App (offline),bogus=X,application_fee_paid='),
    { deposit_paid: 'PD Deposit', application_submit: 'PD App (offline)' });
});

await t('click: latest gclid first, then first touch, else none', () => {
  assert.equal(G.clickFor(app().attribution).gclid, GCLID);
  assert.equal(G.clickFor({ first: { gclid: 'firsttouch_gclid_1' }, last: { utm_source: 'x' } }).gclid, 'firsttouch_gclid_1');
  assert.equal(G.clickFor({ last: { gclid: 'bad id!' } }), null);
  assert.equal(G.clickFor(null), null);
});

await t('deposit: Stripe, paid outside Stripe, prepaid only, withdrawn', () => {
  assert.deepEqual(G.depositOf(app().enrolment), { at: '2026-11-20T09:30:00Z', amount: 2250, reference: 'pi_1' });
  assert.equal(G.depositOf({ prepaid: { at: '2026-11-18T00:00:00Z', amount: 2500, reference: 'wire 1' } }).amount, 2500);
  assert.equal(G.depositOf({ deposit: { status: 'paid', outside: true, paidAt: '2026-11-22T00:00:00Z', amount: 2500 }, prepaid: { at: '2026-11-18T00:00:00Z' } }).at, '2026-11-18T00:00:00Z');
  assert.equal(G.depositOf({ deposit: { status: 'processing' } }), null);
  assert.equal(G.depositOf({ withdrawn: true, deposit: { status: 'paid', paidAt: '2026-11-20T00:00:00Z' } }), null);
});

await t('feed rows: every listed event with the gclid, tuition as the deposit value', () => {
  const names = { application_submit: 'PD App', application_fee_paid: 'PD Fee', deposit_paid: 'PD Deposit' };
  const rows = G.feedRows([app()], names, { now, valueMode: 'tuition' });
  assert.deepEqual(rows.map((r) => [r.name, r.time, r.value, r.orderId]), [
    ['PD App', '2026-11-10 10:00:00', 0, 'sub_a1'],
    ['PD Fee', '2026-11-11 10:00:00', 250, 'fee_a1'],
    ['PD Deposit', '2026-11-20 09:30:00', 15500, 'dep_a1'],
  ]);
  assert.ok(rows.every((r) => r.gclid === GCLID));
  assert.equal(G.feedRows([app()], { deposit_paid: 'D' }, { now, valueMode: 'deposit' })[0].value, 2250);
});

await t('feed rows: unlisted events, no gclid, future, and outside the 90-day window are left out', () => {
  assert.equal(G.feedRows([app()], { deposit_paid: 'D' }, { now }).length, 1);
  assert.equal(G.feedRows([app({ attribution: { last: { utm_source: 'meta' } } })], { deposit_paid: 'D' }, { now }).length, 0);
  assert.equal(G.feedRows([app({ enrolment: { deposit: { status: 'paid', amount: 1, paidAt: '2026-12-30T00:00:00Z' } } })], { deposit_paid: 'D' }, { now }).length, 0);
  const old = app({ attribution: { last: { ts: '2026-06-01', gclid: GCLID } } });
  assert.equal(G.feedRows([old], { deposit_paid: 'D' }, { now }).length, 0, 'deposit more than 90 days after the click');
});

await t('csv: Data Manager format by default, legacy on request, optional hashed email', () => {
  const rows = G.feedRows([app()], G.parseNames('deposit_paid=PD Deposit "won"'), { now });
  const dm = G.toCsv(rows, { withEmail: true }).trim().split('\n');
  assert.equal(dm[0], 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID,Event Source,Email');
  assert.equal(dm[1], `${GCLID},PD Deposit won,2026-11-20 09:30:00+00:00,15500.00,USD,dep_a1,WEB,${sha('kid@example.com')}`);
  const legacy = G.toCsv(rows, { format: 'legacy' }).trim().split('\n');
  assert.equal(legacy[0], 'Parameters:TimeZone=+0000');
  assert.equal(legacy[2], `${GCLID},PD Deposit won,2026-11-20 09:30:00,15500.00,USD,dep_a1`);
  assert.equal(G.toCsv([]).trim().split('\n').length, 1);
});

await t('feed endpoint: refuses without the right Basic auth', async () => {
  process.env.GOOGLE_ADS_FEED_USER = 'google'; process.env.GOOGLE_ADS_FEED_PASSWORD = 'a-long-random-password-123';
  process.env.GOOGLE_ADS_OFFLINE_NAMES = 'deposit_paid=PD Deposit';
  const req = (auth) => new Request('http://x/api/ads/google-conversions.csv', { headers: auth ? { authorization: auth } : {} });
  assert.equal((await feed(req())).status, 401);
  assert.equal((await feed(req('Basic ' + Buffer.from('google:wrong').toString('base64')))).status, 401);
  process.env.GOOGLE_ADS_FEED_PASSWORD = 'short';
  assert.equal((await feed(req('Basic ' + Buffer.from('google:short').toString('base64')))).status, 401, 'short passwords are never accepted');
});

await t('deposit event: stable id, value, custom Meta event that leaves Purchase alone', async () => {
  delete process.env.DEPOSIT_VALUE;
  assert.equal(T.depositEventId('a1'), T.depositEventId('a1'));
  assert.notEqual(T.depositEventId('a1'), T.feeEventId('a1'));
  assert.equal(T.depositValue({ deposit: 2250, tuition: 15500 }), 15500);
  assert.equal(T.depositValue({ deposit: 2250, tuition: 0 }), 2250);
  process.env.DEPOSIT_VALUE = 'deposit';
  assert.equal(T.depositValue({ deposit: 2250, tuition: 15500 }), 2250);
  delete process.env.DEPOSIT_VALUE;
  for (const k of ['META_PIXEL_ID', 'META_CAPI_TOKEN', 'TIKTOK_PIXEL_ID', 'TIKTOK_EVENTS_API_TOKEN']) delete process.env[k];
  const r = await T.trackDeposit(app(), { deposit: 2250, tuition: 15500 });
  assert.equal(r.meta.skipped, 'meta not configured');
  assert.equal(r.tiktok.skipped, 'tiktok not configured');
  // What would be sent:
  const ev = T.buildMetaEvent({ name: 'DepositPaid', eventId: T.depositEventId('a1'), person: { email: 'Kid@Example.com' }, attr: { last: { fbclid: 'abc', ts: '2026-11-09' } }, custom: { value: 15500, currency: 'USD' } });
  assert.equal(ev.event_name, 'DepositPaid');
  assert.equal(ev.custom_data.value, 15500);
  assert.deepEqual(ev.user_data.em, [sha('kid@example.com')]);
  assert.match(ev.user_data.fbc, /^fb\.1\.\d+\.abc$/);
});

console.log(`\n${n} ad-conversion tests passed`);
