// Payment options after acceptance (public/plans-kit.mjs). Pure — no DB.
import assert from 'node:assert/strict';
import * as P from '../public/plans-kit.mjs';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };
const sum = (o) => Math.round(o.payments.reduce((a, p) => a + p.amount * 100, 0)) / 100;
const keys = (r) => r.options.map((o) => o.key);
const START = '2027-09-09'; // plan end 2027-07-11, lump due 2027-06-11

t('more than 90 days out: monthly (primary), two, full, and the quiet "balance later"', () => {
  const r = P.paymentOptions({ tuition: 16500, start: START, today: '2026-11-01' });
  assert.deepEqual(keys(r), ['monthly', 'two', 'full', 'later']);
  assert.equal(r.balance, 16500 - 250 - 2250);
  const m = r.options[0];
  assert.equal(m.primary, true);
  assert.deepEqual(m.payments[0], { due: '2026-11-01', amount: 2250, kind: 'deposit' });
  assert.equal(m.payments.length, 1 + 8);
  assert.equal(m.payments[1].due, '2026-12-01');
  assert.equal(m.payments.at(-1).due, '2027-07-01');
  assert.ok(m.payments.slice(1).every((p) => p.amount === 1750 && p.kind === 'instalment'));
  const later = r.options.at(-1);
  assert.equal(later.quiet, true); assert.equal(later.primary, false);
  assert.deepEqual(later.payments[1], { due: '2027-06-11', amount: 14000, kind: 'balance', manual: true });
  for (const o of r.options) assert.equal(sum(o), 16250, `${o.key} adds up to tuition less the fee`);
});

t('every instalment plan ends at least 60 days before the start', () => {
  for (const today of ['2026-10-27', '2027-01-31', '2027-03-15', '2027-05-20', '2027-06-20']) {
    const r = P.paymentOptions({ tuition: 15500, start: START, today });
    for (const o of r.options) for (const p of o.payments) {
      if (p.kind === 'instalment') assert.ok(p.due <= '2027-07-11', `${today} ${o.key} ${p.due}`);
    }
  }
});

t('two instalments (>90 days): 30 days after acceptance and 60 days before the start', () => {
  const two = P.paymentOptions({ tuition: 16500, start: START, today: '2026-11-01' }).options.find((o) => o.key === 'two');
  assert.deepEqual(two.payments.map((p) => [p.due, p.amount]), [['2026-11-01', 2250], ['2026-12-01', 7000], ['2027-07-11', 7000]]);
});

t('75–90 days out: two instalments (half with the deposit) or in full — no monthly, no "later"', () => {
  const r = P.paymentOptions({ tuition: 16500, start: START, today: '2027-06-15' }); // 86 days
  assert.equal(r.daysToStart, 86);
  assert.deepEqual(keys(r), ['two', 'full']);
  assert.equal(r.options[0].primary, true);
  assert.deepEqual(r.options[0].payments.map((p) => [p.due, p.amount]), [['2027-06-15', 9250], ['2027-07-11', 7000]]);
});

t('under 75 days: pay in full only', () => {
  const r = P.paymentOptions({ tuition: 16500, start: START, today: '2027-07-01' });
  assert.deepEqual(keys(r), ['full']);
  assert.equal(r.options[0].primary, true);
  assert.equal(r.options[0].payments[0].amount, 16250);
});

t('monthly needs at least two monthly dates; otherwise two/full', () => {
  const r = P.paymentOptions({ tuition: 15500, start: '2027-02-03', today: '2026-10-27' }); // 99 days
  assert.ok(!keys(r).includes('monthly'));
  assert.equal(r.options[0].key, 'two'); assert.equal(r.options[0].primary, true);
});

t('rounding: the last instalment absorbs the cents', () => {
  const r = P.paymentOptions({ tuition: 15999.99, start: START, today: '2026-11-01' });
  for (const o of r.options) assert.equal(sum(o), 15749.99, o.key);
  assert.deepEqual(P.split(1000, 3), [333, 333, 334]);
});

t('month arithmetic clamps to the month end', () => {
  assert.equal(P.iso(P.addMonths('2027-01-31', 1)), '2027-02-28');
  assert.equal(P.iso(P.addMonths('2026-12-15', 2)), '2027-02-15');
});

t('today\'s charge adds the processing fee for the method', () => {
  const full = P.paymentOptions({ tuition: 16500, start: START, today: '2026-11-01' }).options.find((o) => o.key === 'full');
  assert.deepEqual(P.todayCharge(full, 0.035), { base: 16250, fee: 568.75, total: 16818.75 });
  const m = P.paymentOptions({ tuition: 16500, start: START, today: '2026-11-01' }).options[0];
  assert.deepEqual(P.todayCharge(m, 0), { base: 2250, fee: 0, total: 2250 });
});

t('tuition already covered by the fee + deposit: one payment', () => {
  const r = P.paymentOptions({ tuition: 2000, start: START, today: '2026-11-01' });
  assert.deepEqual(keys(r), ['full']); assert.equal(r.options[0].payments[0].amount, 1750);
});

t('deposit: $2,250 after the fee, $2,500 when the fee is unpaid', () => {
  assert.equal(P.depositFor(250), 2250); assert.equal(P.depositFor(0), 2500); assert.equal(P.depositFor(), 2500);
  const r = P.paymentOptions({ tuition: 16500, paid: 0, deposit: P.depositFor(0), start: START, today: '2026-11-01' });
  assert.equal(r.options[0].payments[0].amount, 2500); assert.equal(r.balance, 14000);
});

t('pay-in-full discount: only on "full", never more than the balance', () => {
  const r = P.paymentOptions({ tuition: 16500, start: START, today: '2026-11-01', fullDiscount: 500 });
  const full = r.options.find((o) => o.key === 'full');
  assert.equal(full.payments[0].amount, 15750); assert.equal(full.discount, 500); assert.equal(full.fullPrice, 16250);
  assert.match(full.label, /save \$500/);
  assert.equal(r.options.find((o) => o.key === 'monthly').payments.reduce((a, p) => a + p.amount, 0), 16250, 'other plans unchanged');
  assert.equal(P.paymentOptions({ tuition: 2700, start: START, today: '2026-11-01', fullDiscount: 500 }).options.find((o) => o.key === 'full').payments[0].amount, 2450 - 200, 'capped at the balance after the deposit');
  assert.equal(P.paymentOptions({ tuition: 16500, start: START, today: '2026-11-01' }).options.find((o) => o.key === 'full').discount, undefined);
});

t('two-instalment discount comes off the final payment; all discounts end 60 days before the start', () => {
  const r = P.paymentOptions({ tuition: 16500, start: START, today: '2026-11-01', discounts: { full: 500, two: 250 } });
  const two = r.options.find((o) => o.key === 'two');
  assert.deepEqual(two.payments.map((p) => p.amount), [2250, 7000, 6750]); assert.equal(two.discount, 250);
  assert.equal(r.options.find((o) => o.key === 'full').payments[0].amount, 15750);
  // 75–90 days: half with the deposit, discount off the second payment
  const mid = P.paymentOptions({ tuition: 16500, start: START, today: '2027-06-15', discounts: { full: 500, two: 250 } });
  assert.deepEqual(mid.options.find((o) => o.key === 'two').payments.map((p) => p.amount), [9250, 6750]);
  // 61 days out: full-only, still discounted; 60 days out: none
  assert.equal(P.paymentOptions({ tuition: 16500, start: START, today: '2027-07-10', discounts: { full: 500 } }).options[0].payments[0].amount, 15750);
  const late = P.paymentOptions({ tuition: 16500, start: START, today: '2027-07-11', discounts: { full: 500, two: 250 } });
  assert.equal(late.daysToStart, 60);
  assert.equal(late.options[0].discount, undefined); assert.equal(late.options[0].payments[0].amount, 16250);
});

console.log(`plans-kit: ${n} passed`);
