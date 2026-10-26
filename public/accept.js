// The acceptance page: the personal link from the acceptance email.
// Shows the offer, lets the family choose how to pay the balance and how to
// pay (card / US bank account), and sends them to Stripe for today's payment.
import { todayCharge } from '/plans-kit.mjs';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2 }).format(Number(n) || 0);
// Calendar dates (YYYY-MM-DD) as written; moments (the hold) in the reader's time zone.
const dateL = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d)
  ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
const dateS = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const pct = (r) => `${(r * 100).toFixed(1).replace(/\.0$/, '')}%`;

const url = new URL(location.href);
const TOKEN_KEY = 'pd-accept-token';
let token = url.searchParams.get('token');
try { if (token) sessionStorage.setItem(TOKEN_KEY, token); else token = sessionStorage.getItem(TOKEN_KEY); } catch { /* private mode */ }
const sessionId = url.searchParams.get('session_id');
const cancelled = url.searchParams.has('cancelled');
// Keep the link out of the address bar (and out of screenshots / history).
history.replaceState(null, '', '/accept');

const S = { offer: null, plan: null, method: 'card', agree: false };

function say(kind, html) { $('#banner').innerHTML = html ? `<div class="banner banner--${kind}">${html}</div>` : ''; }

async function load() {
  if (!token) { say('bad', 'This page needs the personal link from your acceptance email.'); $('#view').innerHTML = ''; return; }
  const qs = new URLSearchParams({ token, ...(sessionId ? { session_id: sessionId } : {}) });
  const res = await fetch(`/api/accept/offer?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { say('bad', esc(data.error || 'Something went wrong. Please try again.')); $('#view').innerHTML = ''; return; }
  S.offer = data.offer;
  if (cancelled && S.offer.state === 'offer') say('info', 'Payment was cancelled — nothing has been charged. You can try again below.');
  if (sessionId && S.offer.state === 'offer') say('info', "We haven't had confirmation from the payment provider yet. If you completed payment, this page will update shortly.");
  render();
}

function advisorCard(o) {
  if (!o.advisor) return '';
  return `<div class="advisor"><span>${esc(String(o.advisor.text || '').replace(/\s*[—-]?\s*or just reply to this email\.?$/i, '.'))}</span><a class="btn btn--line" href="${esc(o.advisor.url)}" target="_blank" rel="noopener">${esc(o.advisor.label)}</a></div>`;
}

function render() {
  const o = S.offer;
  if (o.state === 'enrolled') return renderEnrolled(o);
  if (o.state === 'expired') {
    $('#view').innerHTML = `<section class="card"><h1 class="serif">The hold on your place has passed</h1>
      <p class="lead">We held your place on ${esc(o.program)} until ${esc(dateL(o.holdUntil))}. Please get in touch — admissions can usually extend it.</p>
      <p><a href="mailto:admissions@pacificdiscovery.org">admissions@pacificdiscovery.org</a></p>${advisorCard(o)}</section>`;
    return;
  }
  if (o.state !== 'offer') {
    $('#view').innerHTML = `<section class="card"><h1 class="serif">No offer to confirm</h1><p class="lead">There's nothing to confirm on this application right now. If you think that's wrong, email <a href="mailto:admissions@pacificdiscovery.org">admissions@pacificdiscovery.org</a>.</p></section>`;
    return;
  }
  if (!S.plan) S.plan = (o.options.find((x) => x.primary) || o.options[0]).key;
  const main = o.options.filter((x) => !x.quiet);
  const quiet = o.options.find((x) => x.quiet);
  const sel = o.options.find((x) => x.key === S.plan) || main[0];
  const charge = todayCharge(sel, o.rates[S.method]);
  const later = sel.payments.slice(1);
  const describe = (x) => {
    const rest = x.payments.slice(1);
    if (x.key === 'full') return `Pay the full ${money(x.payments[0].amount)} today — nothing more to pay.`;
    if (x.key === 'later') return `${money(x.payments[0].amount)} today, then ${money(rest[0].amount)} by ${dateL(rest[0].due)}.`;
    if (x.key === 'two') return x.payments[0].amount > o.deposit
      ? `${money(x.payments[0].amount)} today (deposit + first half), then ${money(rest[0].amount)} on ${dateL(rest[0].due)}.`
      : `${money(o.deposit)} deposit today, then ${money(rest[0].amount)} on ${dateL(rest[0].due)} and ${money(rest[1].amount)} on ${dateL(rest[1].due)}.`;
    return `${money(o.deposit)} deposit today, then ${rest.length} monthly payments of about ${money(rest[0].amount)} from ${dateL(rest[0].due)} to ${dateL(rest[rest.length - 1].due)}.`;
  };
  $('#view').innerHTML = `
  <section class="card">
    <p class="small" style="margin:0 0 6px">${esc(o.program)}${o.term ? ` · ${esc(o.term)}` : ''}</p>
    <h1 class="serif">Congratulations${o.firstName ? `, ${esc(o.firstName)}` : ''}!</h1>
    <p class="lead">You've been accepted to <strong>${esc(o.program)}</strong>, starting ${esc(dateL(o.start))}. ${o.options.length === 1 && o.options[0].key === 'full'
      ? `As your program starts in less than ${o.daysToStart < 75 ? '75' : '90'} days, please pay your tuition balance by <strong>${esc(dateL(o.holdUntil))}</strong> to confirm your place.`
      : `Confirm your place by paying your ${money(o.deposit)} deposit by <strong>${esc(dateL(o.holdUntil))}</strong>.`}</p>
    <table class="sum" aria-label="Your tuition">
      <tr><td>Program tuition</td><td>${money(o.tuition)}</td></tr>
      <tr><td>Application fee (paid)</td><td>−${money(o.paid)}</td></tr>
      <tr><td>Deposit</td><td>−${money(o.deposit)}</td></tr>
      <tr class="total"><td>Balance after your deposit</td><td>${money(o.balance)}</td></tr>
    </table>
  </section>
  <section class="card">
    <h2 class="serif">How would you like to pay?</h2>
    <div class="opts" role="radiogroup" aria-label="Payment plan">
      ${main.map((x, i) => `<label class="opt" data-on="${x.key === S.plan}"><input type="radio" name="plan" value="${x.key}"${x.key === S.plan ? ' checked' : ''}>
        <span><span class="t">${esc(x.label)}${i === 0 && x.key === 'monthly' ? '<span class="tag">Most popular</span>' : ''}</span><span class="d" style="display:block">${esc(describe(x))}</span></span></label>`).join('')}
    </div>
    ${quiet ? `<p style="margin:4px 0 0"><button type="button" class="quiet" id="later">${S.plan === 'later' ? '✓ ' : ''}Or pay the ${money(o.deposit)} deposit now and the balance by ${esc(dateL(quiet.payments[1].due))}</button></p>` : ''}
    ${later.length ? `<details style="margin-top:14px"${S.plan === 'later' ? ' open' : ''}><summary class="small">Payment schedule</summary><table class="sched">
      ${sel.payments.map((p, i) => `<tr><td>${i === 0 ? 'Today' : esc(dateS(p.due))}${p.manual ? ' <span class="small">(you pay by this date)</span>' : ''}</td><td>${money(p.amount)}</td></tr>`).join('')}</table>
      <p class="small">${later.some((p) => !p.manual) ? 'Instalments are charged automatically to the card or bank account you use today, and we email you 3 days before each one.' : ''} The ${S.method === 'ach' ? 'bank payment' : 'card processing'} fee (${pct(o.rates[S.method])}) is added to each payment.</p></details>` : ''}
  </section>
  <section class="card">
    <h2 class="serif">Pay with</h2>
    <div class="methods" role="radiogroup" aria-label="Payment method">
      <label class="opt" data-on="${S.method === 'card'}"><input type="radio" name="method" value="card"${S.method === 'card' ? ' checked' : ''}><span><span class="t">Card</span><span class="d" style="display:block">${o.rates.card ? `${pct(o.rates.card)} processing fee` : 'No fee'}</span></span></label>
      <label class="opt" data-on="${S.method === 'ach'}"><input type="radio" name="method" value="ach"${S.method === 'ach' ? ' checked' : ''}><span><span class="t">US bank account</span><span class="d" style="display:block">${o.rates.ach ? `${pct(o.rates.ach)} fee` : 'No fee'} · takes a few days to clear</span></span></label>
    </div>
    <table class="sum" aria-label="Today">
      <tr><td>${sel.key === 'full' ? 'Tuition balance' : sel.payments[0].amount > o.deposit ? 'Deposit + first instalment' : 'Deposit'}</td><td>${money(charge.base)}</td></tr>
      ${charge.fee ? `<tr><td>${S.method === 'ach' ? 'Bank payment fee' : 'Card processing fee'} (${pct(o.rates[S.method])})</td><td>${money(charge.fee)}</td></tr>` : ''}
      <tr class="total"><td>Today</td><td>${money(charge.total)}</td></tr>
    </table>
    <label class="agree"><input type="checkbox" id="agree"${S.agree ? ' checked' : ''}><span>I agree to the ${o.terms ? `<a href="${esc(o.terms.url)}" target="_blank" rel="noopener">${esc(o.terms.title)}</a> (version ${esc(o.terms.version)})` : 'Program Terms & Conditions'}, including the payment and refund terms.</span></label>
    <div class="pay"><span class="small">Secure payment by Stripe. You'll come straight back here.</span>
      <button class="btn btn--go" type="button" id="pay"${S.agree ? '' : ' disabled'}>Pay ${money(charge.total)} and confirm my place →</button></div>
  </section>
  ${advisorCard(o)}`;
  document.querySelectorAll('input[name=plan]').forEach((el) => el.addEventListener('change', () => { S.plan = el.value; render(); }));
  document.querySelectorAll('input[name=method]').forEach((el) => el.addEventListener('change', () => { S.method = el.value; render(); }));
  $('#later')?.addEventListener('click', () => { S.plan = S.plan === 'later' ? (main.find((x) => x.primary) || main[0]).key : 'later'; render(); });
  $('#agree').addEventListener('change', (e) => { S.agree = e.target.checked; $('#pay').disabled = !S.agree; });
  $('#pay').addEventListener('click', pay);
}

async function pay(e) {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = 'Opening secure checkout…';
  try {
    const res = await fetch('/api/accept/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, plan: S.plan, method: S.method, agree: S.agree }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    location.href = data.url;
  } catch (err) {
    say('bad', esc(err.message));
    btn.disabled = false; render();
  }
}

function renderEnrolled(o) {
  const rows = (o.schedule || []).map((p, i) => `<tr><td>${i === 0 ? 'Paid' : esc(dateS(p.due))}${p.manual ? ' <span class="small">(you pay by this date)</span>' : ''}</td>
    <td>${money(p.amount)} <span class="st st--${esc(p.status)}">${esc({ paid: 'paid', scheduled: 'automatic', due: 'to pay', processing: 'processing' }[p.status] || p.status)}</span></td></tr>`).join('');
  $('#view').innerHTML = `<section class="card">
    <div class="tick" aria-hidden="true">✓</div>
    <h1 class="serif">${o.processing ? 'Payment received — clearing' : 'Your place is confirmed!'}</h1>
    <p class="lead">${o.processing
      ? `Your bank payment is on its way — bank payments take a few business days to clear. We'll email you as soon as it does and your place on ${esc(o.program)} is confirmed.`
      : `You're going on <strong>${esc(o.program)}</strong>${o.start ? `, starting ${esc(dateL(o.start))}` : ''}. We've emailed you and your parents a confirmation with everything below.`}</p>
    <h2 class="serif">${esc(o.planName || 'Your payments')}</h2>
    <table class="sched">${rows}</table>
    <p class="small" style="margin-top:14px">Your student portal has your pre-departure information, forms and payments: <a href="https://portal.pacificdiscovery.org/login.html">portal.pacificdiscovery.org</a> — sign in with ${esc(o.email)}.</p>
  </section>${advisorCard(o)}`;
}

load().catch(() => say('bad', 'Something went wrong loading your offer. Please refresh.'));
