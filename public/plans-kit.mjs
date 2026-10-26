// plans-kit.mjs — tuition payment options after acceptance. Pure: no I/O,
// no clock (pass `today`). Used by the acceptance page (to show the options)
// and the server (to charge exactly what was shown).
//
// Rules (Program Terms & Conditions → Payments):
//   accepted > 90 days before start   monthly · two instalments · pay in full · (balance later, by 90 days)
//   accepted 75–90 days before start  two instalments · pay in full
//   accepted < 75 days before start   pay in full
// Instalment plans end no later than 60 days before the start date. "Balance
// later" is a lump sum due 90 days before the start date — offered quietly.
// Every option starts with the $2,250 deposit today; the $250 application fee
// is already paid and counts toward tuition.

export const DEPOSIT = 2250;
export const PLAN_END_DAYS = 60;
export const LUMP_DUE_DAYS = 90;
export const MONTHLY_MIN_DAYS = 90;
export const TWO_MIN_DAYS = 75;

const DAY = 864e5;
const cents = (n) => Math.round(Number(n) * 100);
const dollars = (c) => Math.round(c) / 100;

/** YYYY-MM-DD → Date at 00:00 UTC. */
export function day(s) {
  const d = new Date(typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
export const iso = (d) => day(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(day(d).getTime() + n * DAY);
/** Same day next month(s), clamped to the month's last day (Jan 31 → Feb 28). */
export function addMonths(d, n) {
  const x = day(d);
  const y = x.getUTCFullYear(); const m = x.getUTCMonth() + n; const dd = x.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(dd, last)));
}

/** Split `total` cents into `n` payments; the last absorbs the rounding. */
export function split(totalCents, n) {
  const each = Math.floor(totalCents / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? totalCents - each * (n - 1) : each));
}

export function surcharge(amount, rate) {
  return dollars(cents(amount) * Number(rate || 0));
}

/**
 * The payment options for an offer.
 *   tuition   full program price (USD)
 *   paid      already paid toward tuition (the $250 application fee)
 *   start     program start date (YYYY-MM-DD)
 *   today     the day they are choosing (YYYY-MM-DD)
 * Returns { balance, daysToStart, options: [{ key, label, primary, payments: [{ due, amount, kind }] }] }
 * `payments[0]` is always what is charged today.
 */
export function paymentOptions({ tuition, paid = 250, deposit = DEPOSIT, start, today }) {
  const t = day(today); const s = day(start);
  const daysToStart = Math.round((s - t) / DAY);
  const totalC = cents(tuition) - cents(paid);
  const depositC = Math.min(cents(deposit), totalC);
  const balanceC = totalC - depositC;
  const planEnd = addDays(s, -PLAN_END_DAYS);
  const lumpDue = addDays(s, -LUMP_DUE_DAYS);
  const pay = (due, c, kind) => ({ due: iso(due), amount: dollars(c), kind });
  const options = [];

  if (balanceC <= 0) {
    options.push({ key: 'full', label: 'Pay in full', primary: true, payments: [pay(t, totalC, 'deposit')] });
    return { balance: 0, daysToStart, options };
  }

  if (daysToStart > MONTHLY_MIN_DAYS) {
    const dates = [];
    for (let i = 1; i <= 24; i++) { const d = addMonths(t, i); if (d > planEnd) break; dates.push(d); }
    if (dates.length >= 2) {
      options.push({
        key: 'monthly', label: `Monthly payments (${dates.length})`, primary: true,
        payments: [pay(t, depositC, 'deposit'), ...split(balanceC, dates.length).map((c, i) => pay(dates[i], c, 'instalment'))],
      });
    }
  }
  if (daysToStart > TWO_MIN_DAYS) {
    const [a, b] = split(balanceC, 2);
    const payments = daysToStart > MONTHLY_MIN_DAYS
      ? [pay(t, depositC, 'deposit'), pay(addDays(t, 30) < planEnd ? addDays(t, 30) : addDays(planEnd, -14), a, 'instalment'), pay(planEnd, b, 'instalment')]
      // 75–90 days out: the first half goes with the deposit today.
      : [pay(t, depositC + a, 'deposit'), pay(planEnd, b, 'instalment')];
    options.push({ key: 'two', label: 'Two instalments', primary: !options.length, payments });
  }
  options.push({ key: 'full', label: 'Pay in full today', primary: !options.length, payments: [pay(t, totalC, 'deposit')] });
  if (daysToStart > LUMP_DUE_DAYS) {
    options.push({
      key: 'later', label: 'Pay the deposit now and the balance later', primary: false, quiet: true,
      payments: [pay(t, depositC, 'deposit'), { due: iso(lumpDue), amount: dollars(balanceC), kind: 'balance', manual: true }],
    });
  }
  return { balance: dollars(balanceC), daysToStart, options };
}

/** Today's charge for an option + method, with the processing fee. */
export function todayCharge(option, rate) {
  const base = option.payments[0].amount;
  const fee = surcharge(base, rate);
  return { base, fee, total: dollars(cents(base) + cents(fee)) };
}
