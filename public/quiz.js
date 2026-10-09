// pd-apply — the gap-year quiz at /quiz.
//   intro → one question per screen → your details → result (+ start application)
// Scoring is done by the server (/api/quiz/submit); ?preview=1 scores locally
// and sends nothing, for checking the quiz without creating HubSpot contacts.

import { renderStep, FORM_CSS, esc, safeHtml, stepFields, validateField, isVisible } from '/form-kit.mjs';
import { scoreQuiz, archetypeByKey } from '/quiz-kit.mjs';

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const banner = $('#banner');
const STATE_KEY = 'pd-quiz-state';
const S = { schema: null, pages: [], i: -1, values: {}, preview: false, form: null, busy: false };

const store = {
  get(k, s = sessionStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = sessionStorage) { try { s.setItem(k, v); } catch { /* private mode */ } },
  del(k, s = sessionStorage) { try { s.removeItem(k); } catch { /* ignore */ } },
};

function notifyParent() {
  if (window.parent === window) return;
  requestAnimationFrame(() => window.parent.postMessage({ pdApplyHeight: document.documentElement.scrollHeight }, '*'));
}
new ResizeObserver(notifyParent).observe(document.body);
function say(kind, html) { banner.innerHTML = html ? `<div class="banner banner--${kind}">${html}</div>` : ''; }
function focusTop() { $('#main').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'smooth' }); notifyParent(); }
function save() { store.set(STATE_KEY, JSON.stringify({ i: S.i, values: S.values })); }

function readCookie(name) {
  try { const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)); return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; }
}
function attribution() {
  const url = new URL(location.href);
  const flat = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) { const v = url.searchParams.get(k); if (v) flat[k] = v; }
  let c = {};
  try { c = window.PDAttribution?.get?.() || {}; } catch { /* blocked */ }
  const page = url.searchParams.get('page');
  return { ...flat, landing: page || `${url.origin}${url.pathname}`, referrer: document.referrer || undefined, first: c.f || null, last: c.l || null,
    hutk: readCookie('hubspotutk'), pageUri: page && /^https?:/.test(page) ? page : `${url.origin}${url.pathname}`, pageName: document.title };
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  const style = document.createElement('style');
  style.textContent = FORM_CSS;
  document.head.appendChild(style);
  const url = new URL(location.href);
  if (url.searchParams.get('embed') === '1' || window.parent !== window) document.body.classList.add('embedded');
  S.preview = url.searchParams.get('preview') === '1';
  try {
    const res = await fetch('/api/quiz/schema');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The quiz is unavailable right now.');
    S.schema = data.schema;
  } catch (err) {
    view.innerHTML = `<h1 class="serif">The quiz is unavailable right now</h1><p class="lead">${esc(err.message)}</p><p>Please try again shortly, or email <a href="mailto:info@pacificdiscovery.org">info@pacificdiscovery.org</a>.</p>`;
    return;
  }
  S.pages = (S.schema.steps.find((s) => s.key === 'quiz')?.sections || []).map((sec) => ({ kind: 'q', sec }));
  S.pages.push({ kind: 'contact' });
  if (S.preview) say('info', '<strong>Preview:</strong> answers are not saved and nothing is sent to HubSpot.');
  try {
    const st = JSON.parse(store.get(STATE_KEY) || 'null');
    if (st && !S.preview) { S.values = st.values || {}; S.i = Math.min(st.i ?? -1, S.pages.length - 1); }
  } catch { /* ignore */ }
  show();
}

function show() {
  if (S.i < 0) return showIntro();
  const p = S.pages[S.i];
  if (p.kind === 'contact') return showContact();
  return showQuestion(p.sec);
}
function go(delta) { S.i = Math.max(-1, Math.min(S.pages.length - 1, S.i + delta)); save(); show(); focusTop(); }

function progress() {
  const total = S.pages.length;
  const pct = Math.round(((S.i + 1) / (total + 1)) * 100);
  return `<div class="qbar" aria-hidden="true"><span style="width:${pct}%"></span></div>`;
}

// ── intro ───────────────────────────────────────────────────────────────────
function showIntro() {
  const st = S.schema.settings || {};
  const n = S.pages.length - 1;
  view.innerHTML = `
    <h1 class="serif">${esc(st.introTitle || S.schema.title || 'Gap year quiz')}</h1>
    <p class="lead">${esc(st.introBody || '')}</p>
    <ul class="intro-list"><li>${n} questions</li><li>About 3 minutes</li><li>Instant result</li></ul>
    <div class="actions"><span class="small">Your answers stay private.</span><button class="btn btn--primary" id="go" type="button">${esc(st.startLabel || 'Start the quiz')} →</button></div>`;
  $('#go').onclick = () => go(1);
  notifyParent();
}

// ── one question ────────────────────────────────────────────────────────────
function isChoice(f) { return ['radio', 'select', 'checkbox'].includes(f.type) && Array.isArray(f.options) && f.options.length; }

function showQuestion(sec) {
  const fields = sec.fields || [];
  const n = S.pages.length - 1;
  const single = fields.length === 1 && isChoice(fields[0]) ? fields[0] : null;
  const head = `${progress()}<p class="qcount">Question ${S.i + 1} of ${n}</p>`;
  const nav = (auto) => `<div class="actions"><button class="link" type="button" id="back">← Back</button><button class="btn btn--primary${auto ? ' hidden' : ''}" type="button" id="next">Next →</button></div>`;

  if (single) {
    const f = single;
    const multi = f.type === 'checkbox';
    const max = Number(f.maxChoices) || 0;
    const cur = () => (multi ? (Array.isArray(S.values[f.key]) ? S.values[f.key] : []) : S.values[f.key]);
    view.innerHTML = `${head}
      <h1 class="serif qtitle" id="ql">${esc(f.label)}</h1>
      ${f.help ? `<p class="qhelp">${esc(f.help)}</p>` : ''}
      <div class="opts" role="${multi ? 'group' : 'radiogroup'}" aria-labelledby="ql">
        ${f.options.map((o, k) => `<button type="button" class="opt" role="${multi ? 'checkbox' : 'radio'}" ${multi ? 'data-multi' : ''} data-k="${k}"><span class="mk" aria-hidden="true"></span><span>${esc(o)}</span></button>`).join('')}
      </div>
      <p class="qerr" id="qerr" role="alert"></p>
      ${nav(!multi && !!cur())}`;
    const paint = () => {
      const v = cur();
      view.querySelectorAll('.opt').forEach((b) => {
        const o = f.options[Number(b.dataset.k)];
        const on = multi ? v.includes(o) : v === o;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.setAttribute('aria-disabled', multi && max && !on && v.length >= max ? 'true' : 'false');
      });
      if (!multi) $('#next').classList.toggle('hidden', !v);
    };
    view.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => {
      const o = f.options[Number(b.dataset.k)];
      $('#qerr').textContent = '';
      if (multi) {
        const v = cur().slice();
        const at = v.indexOf(o);
        if (at >= 0) v.splice(at, 1);
        else if (max && v.length >= max) { $('#qerr').textContent = `You can pick up to ${max} — untick one first.`; return; }
        else v.push(o);
        S.values[f.key] = v; save(); paint();
      } else {
        S.values[f.key] = o; save(); paint();
        setTimeout(() => go(1), 220);
      }
    }));
    paint();
    $('#back').onclick = () => go(-1);
    $('#next').onclick = () => {
      const err = validateField(S.schema, f, S.values[f.key], S.values);
      if (err) { $('#qerr').textContent = err; return; }
      go(1);
    };
    view.querySelector('.opt[aria-checked=true]')?.focus({ preventScroll: true });
    notifyParent();
    return;
  }

  // Anything else (text questions, several fields on one page): form-kit.
  const mini = { ...S.schema, steps: [{ key: 'page', sections: [sec] }] };
  view.innerHTML = `${head}${sec.title ? `<h1 class="serif qtitle">${esc(sec.title)}</h1>` : ''}<form id="f" novalidate><div id="fields"></div>${nav(false)}</form>`;
  S.form = renderStep($('#fields'), mini, 'page', { values: S.values, onChange: notifyParent });
  $('#back').onclick = () => go(-1);
  $('#f').addEventListener('submit', (e) => e.preventDefault());
  $('#next').onclick = () => {
    const r = S.form.validate();
    if (!r.ok) { S.form.focusFirstError(); return; }
    Object.assign(S.values, S.form.values()); save(); go(1);
  };
  notifyParent();
}

// ── details + submit ────────────────────────────────────────────────────────
function showContact() {
  const st = S.schema.settings || {};
  const sec = S.schema.steps.find((s) => s.key === 'contact');
  view.innerHTML = `${progress()}
    <h1 class="serif qtitle">${esc(sec?.sections?.[0]?.title || 'Where should we send your results?')}</h1>
    <p class="qhelp">${esc(st.contactIntro || 'We’ll show your result on the next screen and email you a copy with programs that match.')}</p>
    <form id="f" novalidate>
      <div id="fields"></div>
      <div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="actions"><button class="link" type="button" id="back">← Back</button><button class="btn btn--go" type="submit">${esc(st.submitLabel || 'See my result')} →</button></div>
    </form>`;
  S.form = renderStep($('#fields'), { ...S.schema, steps: [{ key: 'contact', sections: sec?.sections || [] }] }, 'contact', { values: S.values, onChange: notifyParent });
  $('#back').onclick = () => { Object.assign(S.values, S.form.values()); go(-1); };
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (S.busy) return;
    say('', S.preview ? '' : '');
    const r = S.form.validate();
    if (!r.ok) { say('bad', 'Please check the highlighted fields.'); S.form.focusFirstError(); return; }
    Object.assign(S.values, S.form.values()); save();
    const missing = firstUnanswered();
    if (missing >= 0) { say('bad', 'Please answer every question first.'); S.i = missing; show(); return; }
    const btn = e.submitter || $('#f button[type=submit]');
    S.busy = true; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Working out your result…';
    try {
      let out;
      if (S.preview) {
        const sc = scoreQuiz(S.schema, S.values);
        out = { archetype: sc.archetype, result: archetypeByKey(S.schema, sc.archetype), ranked: sc.ranked };
      } else {
        const res = await fetch('/api/quiz/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: S.values, hp: $('#f [name=website]').value, attribution: attribution() }) });
        out = await res.json().catch(() => ({}));
        if (!res.ok) { const err = new Error(out.error || `Something went wrong (${res.status}).`); err.errors = out.errors; throw err; }
      }
      rememberForApplication();
      store.del(STATE_KEY);
      say('', '');
      showResult(out);
    } catch (err) {
      S.busy = false; btn.disabled = false; btn.textContent = `${st.submitLabel || 'See my result'} →`;
      if (err.errors) S.form.setErrors(err.errors);
      say('bad', esc(err.message));
    }
  });
  notifyParent();
}

function firstUnanswered() {
  for (let i = 0; i < S.pages.length - 1; i += 1) {
    for (const f of S.pages[i].sec.fields || []) {
      if (!isVisible(S.schema, f, S.values)) continue;
      if (validateField(S.schema, f, S.values[f.key], S.values)) return i;
    }
  }
  return -1;
}

// Carry name / email / phone into the application (same browser).
function rememberForApplication() {
  const v = {};
  for (const k of ['name', 'email', 'mobile']) if (S.values[k]) v[k] = S.values[k];
  try { localStorage.setItem('pd-quiz-prefill', JSON.stringify({ at: Date.now(), values: v })); } catch { /* ignore */ }
}

// ── result ──────────────────────────────────────────────────────────────────
function showResult(out) {
  const a = out.result || {};
  const st = S.schema.settings || {};
  const first = S.values.name?.first || '';
  const cta = a.ctaUrl || '/';
  const scores = Array.isArray(out.ranked) && st.showScores ? `<div class="scores" aria-label="Your scores">${out.ranked.map((r) => {
    const max = Math.max(1, ...out.ranked.map((x) => x.score));
    return `<div><span>${esc(archetypeByKey(S.schema, r.key)?.name || r.key)}</span><i style="width:${Math.round((r.score / max) * 100)}%"></i><b>${r.score}</b></div>`;
  }).join('')}</div>` : '';
  view.innerHTML = `<div class="result">
    <span class="result-badge">${first ? `${esc(first)}, your result` : 'Your result'}</span>
    <h1 class="serif">${esc(a.headline || a.name || 'Thanks!')}</h1>
    <div class="body">${safeHtml(a.html || '')}</div>
    ${scores}
    <div class="actions">
      <button class="link" type="button" id="again">Retake the quiz</button>
      <span style="display:flex;gap:10px;flex-wrap:wrap">
        ${st.secondaryCtaUrl ? `<a class="btn" href="${esc(st.secondaryCtaUrl)}" target="_top">${esc(st.secondaryCtaLabel || 'Talk to an advisor')}</a>` : ''}
        <a class="btn btn--primary" id="cta" href="${esc(cta)}${S.preview && cta === '/' ? '?preview=1' : ''}" target="_top">${esc(a.ctaLabel || 'Start your application')} →</a>
      </span>
    </div></div>`;
  $('#again').onclick = () => { S.values = {}; S.i = -1; S.busy = false; store.del(STATE_KEY); show(); focusTop(); };
  focusTop();
}

boot();
