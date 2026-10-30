// Browser walk-through of the acceptance page (stage 4a).
// node test/accept.smoke.mjs  (needs TEST_PG_URL; SHOTS=dir to save screenshots)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { setupDb, fakeUpstreams, startServer } from './harness.mjs';

Object.assign(process.env, { HUBSPOT_TOKEN: 'x', STRIPE_SECRET_KEY: 'sk', APPLY_SERVICE_KEY: 'svc', APPLY_SITE_URL: 'http://localhost:8898', URL: 'http://localhost:8898', SMTP_USER: 'a@b.org', SMTP_PASS: 'x' });
const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
schema.settings.discounts = { enabled: true, full: { semester: 500, mini: 250 }, two: { semester: 250 } };
const { pool } = await setupDb(schema);
const up = fakeUpstreams();
const N = await import('../netlify/functions/_lib/notify.mjs');
const mails = [];
N.__setTransport({ sendMail: async (m) => { mails.push(m); return {}; } });
const { decide } = await import('../netlify/functions/_lib/decisions.mjs');
const server = await startServer(8898);
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const quiet = { error() {}, warn() {} };

async function acceptedApp(email) {
  up.crm.deals.set('950', { id: '950', properties: { pipeline: '74958084', dealstage: 'f9i' } });
  const answers = { preferredName: 'Sam', parent1Email: `parent.${email}` };
  const [{ id }] = (await pool.query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, interview_at, paid_at, payment, hubspot_contact_id, hubspot_deal_id, sync)
     VALUES ($1,$2,'Sam','Lee','South America Gap Semester','Fall 2027','paid',$3, now(), now(), now(), now(), $4, '501', '950', $5) RETURNING id`,
    [`h-${email}`, email, JSON.stringify(answers), JSON.stringify({ reference: 'pi_fee', base: 250, total: 258.75, currency: 'usd' }),
      JSON.stringify({ hsProgram: { record: { id: 'P5' } } })])).rows;
  await decide(id, { outcome: 'accepted', by: 'Megan' }, { schema, log: quiet });
  return { id, token: /\/accept\?token=([\w-]+)/.exec(mails.at(-1).text)[1] };
}

try {
  for (const [viewport, tag] of [[{ width: 1200, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'mobile']]) {
    const { token } = await acceptedApp(`ui.${tag}@x.org`);
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts/i.test(m.text())) errors.push(m.text()); });
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('https://checkout.stripe.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Stripe (test stand-in)</h1>' }));
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/accept-${tag}-${name}.png`, fullPage: true }); };

    await page.goto(`http://localhost:8898/accept?token=${token}`);
    await page.waitForSelector('input[name=plan]');
    assert.equal(new URL(page.url()).search, '', 'token removed from the address bar');
    assert.match(await page.textContent('h1'), /Congratulations, Sam/);
    assert.equal(await page.inputValue('input[name=plan]:checked'), 'monthly');
    assert.match(await page.textContent('#pay'), /Pay \$2,328\.75/);
    assert.ok(await page.isDisabled('#pay'), 'needs the terms ticked');
    assert.match(await page.textContent('.opt--best'), /Best value.*You save \$500/s);
    await shot('1-offer');

    await page.check('input[name=method][value=ach]');
    assert.match(await page.textContent('#pay'), /Pay \$2,250 and/);
    await page.click('#later');
    await page.waitForSelector('details[open]');
    assert.match(await page.textContent('.sched'), /\$13,000/);
    await shot('2-later');
    await page.click('#later');
    assert.equal(await page.inputValue('input[name=plan]:checked'), 'monthly');

    await page.check('#agree');
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.click('#pay')]);
    const s = [...up.stripe.sessions.values()].at(-1);
    assert.equal(s.metadata.plan, 'monthly'); assert.equal(s.metadata.method, 'ach');

    // back from Stripe, paid by card this time
    Object.assign(s, { status: 'complete', payment_status: 'paid' });
    await page.goto(s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id));
    await page.waitForSelector('.tick');
    assert.match(await page.textContent('h1'), /confirmed/);
    assert.match(await page.textContent('.sched'), /paid/);
    await shot('3-confirmed');
    // a payment that didn't go through: pay it from the page, or change the card
    const appId = (await pool.query(`SELECT id FROM applications WHERE email = $1`, [`ui.${tag}@x.org`])).rows[0].id;
    await pool.query(`UPDATE applications SET enrolment = jsonb_set(enrolment, '{schedule,1}', (enrolment->'schedule'->1) || '{"status":"needs_admissions","attempts":3}') WHERE id = $1`, [appId]);
    await page.goto(`http://localhost:8898/accept?token=${token}`);
    await page.waitForSelector('[data-pay="1"]');
    assert.match(await page.textContent('[data-pay="1"]'), /Pay \$1,625 /, 'their bank account by default (no fee)');
    assert.ok(await page.isVisible('#upd'));
    await page.check('input[name=pm][value=card]');
    assert.match(await page.textContent('[data-pay="1"]'), /Pay \$1,681\.88/);
    await shot('4-payment-needed');
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.click('[data-pay="1"]')]);
    assert.equal([...up.stripe.sessions.values()].at(-1).metadata.payment_kind, 'item');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`  ✓ ${tag}: offer → choose plan + method → Stripe → confirmed`);
  }
  // bank transfer: a quiet link for US families, a third option for families abroad
  for (const [country, tag] of [[null, 'us'], ['New Zealand', 'intl']]) {
    const { id, token } = await acceptedApp(`wire.${tag}@x.org`);
    if (country) await pool.query(`UPDATE applications SET answers = answers || $2::jsonb WHERE id = $1`, [id, JSON.stringify({ homeCountry: country })]);
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.goto(`http://localhost:8898/accept?token=${token}`);
    await page.waitForSelector('input[name=plan]');
    if (!country) {
      assert.equal(await page.$('input[name=method][value=wire]'), null, 'not a main option in the US');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/wire-us-link.png`, fullPage: true });
      await page.click('#wire-link');
    } else {
      assert.ok(await page.$('input[name=method][value=wire]'), 'an option abroad');
      await page.check('input[name=method][value=wire]');
    }
    await page.waitForSelector('.wire');
    assert.match(await page.textContent('.wire'), /TRWIUS35XXX/);
    assert.match(await page.textContent('#pay'), /Email me the details/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wire-${tag}.png`, fullPage: true });
    await page.check('#agree');
    await page.click('#pay');
    await page.waitForSelector('.banner--ok');
    await page.waitForSelector('.note');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wire-${tag}-sent.png`, fullPage: true });
    assert.ok(mails.some((m) => /Bank transfer details/.test(m.subject) && m.to.includes(`wire.${tag}@x.org`)));
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`  ✓ bank transfer (${tag})`);
  }
  if (SHOTS) {
    const { writeFileSync } = await import('node:fs');
    for (const m of mails.filter((x) => /accepted|confirmed/.test(x.subject))) writeFileSync(`${SHOTS}/email-${/confirmed/.test(m.subject) ? 'enrolled' : 'accepted'}.html`, m.html);
  }
} finally {
  await browser.close(); server.close(); up.restore(); await pool.end();
}
