// pd-apply — the four-step application flow.
//   step1      short form (identity, program, term) → creates the application
//   step2      the full application
//   interview  HubSpot meeting scheduler (prefilled); booking advances the flow
//   payment    $250 application fee + 3.5% card fee via Stripe Checkout
// The applicant's resume token lives in localStorage; every screen is
// re-derived from /api/apply/status, so reloading or coming back later works.

import { renderStep, FORM_CSS, esc, safeHtml } from '/form-kit.mjs';

const TOKEN_KEY = 'pd-apply-token';
const ATTR_KEY = 'pd-apply-attribution';
const DRAFT_KEY = 'pd-apply-draft-step2';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const banner = $('#banner');

const S = { schema: null, token: null, status: null, form: null };

// ── storage (never fatal) ───────────────────────────────────────────────────
const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { s.setItem(k, v); } catch { /* private mode */ } },
  del(k, s = localStorage) { try { s.removeItem(k); } catch { /* ignore */ } },
};

// ── api ─────────────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`/api/apply/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : form,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `Something went wrong (${res.status}). Please try again.`);
    err.status = res.status; err.errors = data.errors;
    throw err;
  }
  return data;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function say(kind, html) {
  banner.innerHTML = html ? `<div class="banner banner--${kind}">${html}</div>` : '';
}

function money(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: (S.schema?.settings?.currency || 'usd').toUpperCase() }).format(n);
}

function setProgress(step) {
  const order = ['step1', 'step2', 'interview', 'payment', 'done'];
  const at = order.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.dataset.state = i < at ? 'done' : i === at ? 'current' : 'todo';
    if (i === at) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span> ${esc(label || 'Please wait…')}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

function focusTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#main').focus({ preventScroll: true });
  notifyParent();
}

/** When embedded on pacificdiscovery.org, tell the parent our height. */
function notifyParent() {
  if (window.parent === window) return;
  requestAnimationFrame(() => window.parent.postMessage({ pdApplyHeight: document.documentElement.scrollHeight }, '*'));
}
new ResizeObserver(notifyParent).observe(document.body);

function texts() { return S.schema?.settings?.texts || {}; }

// ── attribution (captured once, on the landing visit) ───────────────────────
function captureAttribution(url) {
  const prev = JSON.parse(store.get(ATTR_KEY, sessionStorage) || 'null');
  if (prev) return prev;
  const a = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) {
    const v = url.searchParams.get(k);
    if (v) a[k] = v;
  }
  // When embedded, the parent page can pass its URL as ?page=…
  a.landing = url.searchParams.get('page') || (window.parent !== window ? document.referrer : '') || `${url.origin}${url.pathname}`;
  if (document.referrer) a.referrer = document.referrer;
  store.set(ATTR_KEY, JSON.stringify(a), sessionStorage);
  return a;
}

function hiddenValues(attr) {
  const out = {};
  for (const st of S.schema.steps) for (const sec of st.sections) for (const f of sec.fields) {
    if (f.type !== 'hidden' || !f.source) continue;
    if (f.source.startsWith('query:')) { const v = attr[f.source.slice(6)]; if (v) out[f.key] = v; }
    else if (f.source === 'pageUrl') out[f.key] = attr.landing || '';
  }
  return out;
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  const style = document.createElement('style');
  style.textContent = FORM_CSS;
  document.head.appendChild(style);

  const url = new URL(location.href);
  if (url.searchParams.get('embed') === '1' || window.parent !== window) document.body.classList.add('embedded');
  const attr = captureAttribution(url);

  // A token in the URL (Stripe return, "continue your application" links)
  // moves into storage and out of the address bar.
  const urlToken = url.searchParams.get('token');
  if (urlToken) store.set(TOKEN_KEY, urlToken);
  S.token = store.get(TOKEN_KEY);
  const sessionId = url.searchParams.get('session_id');
  const cancelled = url.searchParams.get('cancelled');
  if (url.searchParams.has('token') || sessionId || cancelled) {
    for (const k of ['token', 'session_id', 'paid', 'cancelled']) url.searchParams.delete(k);
    history.replaceState(null, '', url.pathname + (url.search || ''));
  }

  try {
    const { schema } = await api('schema');
    S.schema = schema;
  } catch (err) {
    view.innerHTML = `<h1 class="serif">Applications are temporarily unavailable</h1><p class="lead">${esc(err.message)}</p><p>Please email <a href="mailto:info@pacificdiscovery.org">info@pacificdiscovery.org</a> and we'll help you apply.</p>`;
    return;
  }

  if (S.token) {
    try {
      S.status = await api(`status?token=${encodeURIComponent(S.token)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ''}`);
    } catch (err) {
      if (err.status === 404) { store.del(TOKEN_KEY); S.token = null; }
      else { say('bad', esc(err.message)); }
    }
  }
  if (cancelled && S.status && !S.status.paid) say('info', 'Payment was cancelled — you can try again whenever you are ready.');
  if (sessionId && S.status && !S.status.paid) {
    // Webhook may still be on its way; poll briefly.
    return showPaymentPending(sessionId);
  }
  route(attr);
}

function route(attr = captureAttribution(new URL(location.href))) {
  const step = S.status?.step || 'step1';
  setProgress(step);
  if (step === 'step1') return showStep1(attr);
  if (step === 'step2') return showStep2();
  if (step === 'interview') return showInterview();
  if (step === 'payment') return showPayment();
  return showDone();
}

function helloLine() {
  const st = S.status;
  if (!st) return '';
  return `<p class="hello"><span>Applying as <strong>${esc(st.firstName)} ${esc(st.lastName)}</strong></span>${st.program ? `<span class="pill">${esc(st.program)}${st.term ? ` · ${esc(st.term)}` : ''}</span>` : ''}<button type="button" class="link" id="notme">Not you? Start a new application</button></p>`;
}

function wireNotMe() {
  $('#notme')?.addEventListener('click', () => {
    if (!confirmReset()) return;
    store.del(TOKEN_KEY); store.del(DRAFT_KEY, sessionStorage);
    S.token = null; S.status = null; say('', '');
    route();
  });
}
function confirmReset() {
  // Inline confirm keeps the page free of blocking browser dialogs.
  const btn = $('#notme');
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  btn.textContent = 'Click again to start a new application';
  return false;
}

// ── step 1 ──────────────────────────────────────────────────────────────────
function showStep1(attr) {
  const t = texts();
  const st = S.schema.steps.find((s) => s.key === 'step1');
  view.innerHTML = `
    <h1 class="serif">${esc(t.welcomeTitle || 'Apply to Pacific Discovery')}</h1>
    <p class="lead">${esc(t.welcomeBody || '')}</p>
    ${st?.intro ? `<div class="lead">${safeHtml(st.intro)}</div>` : ''}
    <form id="f" novalidate>
      <div id="fields"></div>
      <div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="actions"><span class="small">Takes about 2 minutes.</span><button class="btn btn--primary" type="submit">${esc(st?.submitLabel || 'Next')} →</button></div>
    </form>`;
  S.form = renderStep($('#fields'), S.schema, 'step1', { onChange: notifyParent });
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('', '');
    const res = S.form.validate();
    if (!res.ok) { say('bad', 'Please check the highlighted fields.'); S.form.focusFirstError(); return; }
    const btn = e.submitter || $('#f button[type=submit]');
    busy(btn, true, 'Saving…');
    try {
      const out = await api('start', { method: 'POST', body: { values: { ...S.form.values(), ...hiddenValues(attr) }, hp: $('#f [name=website]').value, attribution: attr } });
      S.token = out.token;
      store.set(TOKEN_KEY, out.token);
      S.status = out.status;
      route();
      focusTop();
    } catch (err) {
      busy(btn, false);
      if (err.errors) S.form.setErrors(err.errors);
      say('bad', esc(err.message));
      S.form.focusFirstError();
    }
  });
  notifyParent();
}

// ── step 2 ──────────────────────────────────────────────────────────────────
function showStep2() {
  const st = S.schema.steps.find((s) => s.key === 'step2');
  let draft = {};
  try { draft = JSON.parse(store.get(DRAFT_KEY, sessionStorage) || '{}'); } catch { /* ignore */ }
  view.innerHTML = `
    ${helloLine()}
    <h1 class="serif">${esc(st?.title || 'Your application')}</h1>
    <p class="lead">${st?.intro ? safeHtml(st.intro) : 'Thanks! Now the full application — it takes about 10–15 minutes. Fields marked * are required.'}</p>
    <form id="f" novalidate>
      <div id="fields"></div>
      <div class="actions"><span class="small">Next: book your interview.</span><button class="btn btn--primary" type="submit">${esc(st?.submitLabel || 'Submit application')} →</button></div>
    </form>`;
  wireNotMe();
  // Conditions can reference step-1 answers (program/term), which the server
  // knows; for the browser they are not needed by the seeded form.
  S.form = renderStep($('#fields'), S.schema, 'step2', {
    // email / mobile: the student's, so parents can't reuse them (checked again on the server)
    values: { ...draft, program: S.status?.program, term: S.status?.term, email: S.status?.email, mobile: S.status?.mobile || undefined },
    onChange: (v) => {
      // Keep an unsent draft for this tab only (no files, no cross-session storage).
      const { photo, ...rest } = v;
      store.set(DRAFT_KEY, JSON.stringify(rest), sessionStorage);
      notifyParent();
    },
    upload: async (file, field) => {
      const fd = new FormData();
      fd.append('token', S.token);
      fd.append('field', field.key);
      fd.append('file', file);
      return api('upload', { method: 'POST', form: fd });
    },
  });
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('', '');
    if (S.form.busy()) { say('info', 'Please wait for your upload to finish.'); return; }
    const res = S.form.validate();
    if (!res.ok) { say('bad', `Please check the ${Object.keys(res.errors).length === 1 ? 'highlighted field' : `${Object.keys(res.errors).length} highlighted fields`}.`); S.form.focusFirstError(); return; }
    const btn = e.submitter || $('#f button[type=submit]');
    busy(btn, true, 'Submitting…');
    try {
      const out = await api('step2', { method: 'POST', body: { token: S.token, values: S.form.values() } });
      store.del(DRAFT_KEY, sessionStorage);
      S.status = out.status;
      route();
      focusTop();
    } catch (err) {
      busy(btn, false);
      if (err.errors) S.form.setErrors(err.errors);
      say('bad', esc(err.message));
      S.form.focusFirstError();
    }
  });
  notifyParent();
}

// ── interview ───────────────────────────────────────────────────────────────
function meetingUrl() {
  const base = S.schema.settings.meetingUrl || 'https://meetings.hubspot.com/eda-admissions/pacific-discovery-interviews';
  const u = new URL(base);
  u.searchParams.set('embed', 'true');
  if (S.status?.firstName) u.searchParams.set('firstName', S.status.firstName);
  if (S.status?.lastName) u.searchParams.set('lastName', S.status.lastName);
  if (S.status?.email) u.searchParams.set('email', S.status.email);
  return u.toString();
}

function showInterview() {
  const t = texts();
  view.innerHTML = `
    ${helloLine()}
    <h1 class="serif">${esc(t.interviewTitle || 'Book your admissions interview')}</h1>
    <p class="lead">${esc(t.interviewBody || '')}</p>
    <div id="booked"></div>
    <div class="meet" id="meet"><iframe title="Book your admissions interview" src="${esc(meetingUrl())}" loading="lazy" allow="clipboard-write"></iframe></div>
    <div class="actions">
      <span class="small">Once you pick a time you'll move straight on to the application fee.</span>
      ${S.schema.settings.allowSkipInterview ? '<button type="button" class="btn" id="skip">Skip for now</button>' : ''}
    </div>`;
  wireNotMe();
  $('#skip')?.addEventListener('click', async (e) => {
    busy(e.currentTarget, true);
    try { S.status = (await api('interview', { method: 'POST', body: { token: S.token, booking: { skipped: true } } })).status; route(); focusTop(); }
    catch (err) { busy(e.currentTarget, false); say('bad', esc(err.message)); }
  });
  notifyParent();
}

// HubSpot's scheduler posts { meetingBookSucceeded: true, meetingsPayload } to
// the page that embeds it once a time is booked.
window.addEventListener('message', async (e) => {
  if (!/(^|\.)hubspot\.com$/.test(new URL(e.origin || 'http://x').hostname)) return;
  const d = e.data;
  if (!d || !d.meetingBookSucceeded || S.status?.step !== 'interview') return;
  const ev = d.meetingsPayload?.bookingResponse?.event || {};
  const start = ev.dateTime || ev.startTime || null;
  let label = ev.dateString || null;
  if (!label && start) {
    try { label = new Date(Number(start) || start).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }); } catch { /* keep null */ }
  }
  $('#booked').innerHTML = `<div class="booked"><span aria-hidden="true">✓</span><div><strong>Interview booked${label ? ` — ${esc(label)}` : ''}</strong>A calendar invite is on its way to your email. Taking you to the last step…</div></div>`;
  try {
    const out = await api('interview', { method: 'POST', body: { token: S.token, booking: { start: start ? String(start) : null, label, organizer: d.meetingsPayload?.bookingResponse?.organizer?.name || null } } });
    S.status = out.status;
    setTimeout(() => { route(); focusTop(); }, 1600);
  } catch (err) {
    say('bad', `${esc(err.message)} Your interview is booked — refresh this page to continue.`);
  }
});

// ── payment ─────────────────────────────────────────────────────────────────
function showPayment() {
  const t = texts();
  const fee = S.status?.fee || S.schema.fee;
  const pct = `${(fee.rate * 100).toFixed(1).replace(/\.0$/, '')}%`;
  view.innerHTML = `
    ${helloLine()}
    ${S.status?.interview ? `<div class="booked"><span aria-hidden="true">✓</span><div><strong>Interview booked${S.status.interview.label ? ` — ${esc(S.status.interview.label)}` : ''}</strong>Check your email for the calendar invite.</div></div>` : ''}
    <h1 class="serif">${esc(t.paymentTitle || 'Pay your application fee')}</h1>
    <p class="lead">${esc(t.paymentBody || '')}</p>
    <table class="fee" aria-label="Amount due">
      <tr><td>Application fee</td><td>${money(fee.base)}</td></tr>
      <tr><td>Card processing fee (${pct})</td><td>${money(fee.surcharge)}</td></tr>
      <tr class="total"><td>Total today</td><td>${money(fee.total)}</td></tr>
    </table>
    <div class="actions">
      <span class="small">Secure payment by Stripe. You'll come straight back here afterwards.</span>
      <button class="btn btn--go" type="button" id="pay">Pay ${money(fee.total)} →</button>
    </div>`;
  wireNotMe();
  $('#pay').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Opening secure checkout…');
    try {
      const { url } = await api('checkout', { method: 'POST', body: { token: S.token } });
      if (window.top !== window) window.top.location.href = url; else location.href = url;
    } catch (err) {
      busy(btn, false);
      say('bad', esc(err.message));
    }
  });
  notifyParent();
}

async function showPaymentPending(sessionId) {
  setProgress('payment');
  view.innerHTML = `<div class="loading"><span class="spin" style="border-color:rgba(0,0,0,.15);border-top-color:var(--teal)"></span><p>Confirming your payment…</p></div>`;
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      S.status = await api(`status?token=${encodeURIComponent(S.token)}&session_id=${encodeURIComponent(sessionId)}`);
      if (S.status.paid) break;
    } catch { /* keep trying */ }
  }
  if (!S.status?.paid) say('info', "We haven't received confirmation from the payment provider yet. If you completed payment, you'll get an email receipt and this page will update shortly.");
  route();
}

// ── done ────────────────────────────────────────────────────────────────────
function showDone() {
  const t = texts();
  view.innerHTML = `
    <div class="done">
      <div class="tick" aria-hidden="true">✓</div>
      <h1 class="serif">${esc(t.doneTitle || 'Application complete')}</h1>
      <p class="lead">${esc(t.doneBody || '')}</p>
      ${S.status?.program ? `<p><span class="pill">${esc(S.status.program)}${S.status.term ? ` · ${esc(S.status.term)}` : ''}</span></p>` : ''}
      ${S.status?.interview?.label ? `<p class="small">Interview: ${esc(S.status.interview.label)}</p>` : ''}
      <p><a class="btn" href="https://www.pacificdiscovery.org" target="_top">Back to pacificdiscovery.org</a></p>
    </div>`;
  notifyParent();
}

boot();
