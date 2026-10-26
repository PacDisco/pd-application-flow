// Browser walk-through of the acceptance page (stage 4a).
// node test/accept.smoke.mjs  (needs TEST_PG_URL; SHOTS=dir to save screenshots)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { setupDb, fakeUpstreams, startServer } from './harness.mjs';

Object.assign(process.env, { HUBSPOT_TOKEN: 'x', STRIPE_SECRET_KEY: 'sk', APPLY_SERVICE_KEY: 'svc', APPLY_SITE_URL: 'http://localhost:8898', URL: 'http://localhost:8898', SMTP_USER: 'a@b.org', SMTP_PASS: 'x' });
const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
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
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`  ✓ ${tag}: offer → choose plan + method → Stripe → confirmed`);
  }
  if (SHOTS) {
    const { writeFileSync } = await import('node:fs');
    for (const m of mails.filter((x) => /accepted|confirmed/.test(x.subject))) writeFileSync(`${SHOTS}/email-${/confirmed/.test(m.subject) ? 'enrolled' : 'accepted'}.html`, m.html);
  }
} finally {
  await browser.close(); server.close(); up.restore(); await pool.end();
}
