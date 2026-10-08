// Browser walk-through of the whole flow against the real handlers.
// node test/ui.smoke.mjs  (needs TEST_PG_URL; SHOTS=dir to save screenshots)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { setupDb, memoryStore, fakeUpstreams, startServer } from './harness.mjs';

Object.assign(process.env, { HUBSPOT_TOKEN: 'x', JOTFORM_API_KEY: 'x', STRIPE_SECRET_KEY: 'sk', APPLY_SERVICE_KEY: 'svc', APPLY_SITE_URL: 'http://localhost:8899', URL: 'http://localhost:8899' });
const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
const { pool } = await setupDb(schema);
globalThis.__applyTestStore = memoryStore();
const up = fakeUpstreams();
const server = await startServer(8899);
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });

async function run(viewport, tag) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|hubspot/i.test(m.text())) errors.push(m.text()); });
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  // Stand-in for HubSpot's scheduler: a "Book" button that posts the same
  // message the real embed sends to its parent.
  await page.route('https://meetings.hubspot.com/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="font-family:sans-serif;padding:30px"><h3>HubSpot scheduler (test stand-in)</h3><p id="who">${new URL(r.request().url()).searchParams.get('email')}</p><button id="book">Book 9:00 AM</button><script>document.getElementById('book').onclick=()=>parent.postMessage({meetingBookSucceeded:true,meetingsPayload:{bookingResponse:{event:{dateString:'Tuesday, October 13, 2026 9:00 AM',dateTime:1791882000000}}}},'*')</script></body>` }));
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${tag}-${name}.png`, fullPage: true }); };

  await page.goto('http://localhost:8899/?utm_source=instagram&gclid=abc');
  await page.waitForSelector('#fk_name');
  await shot('1-step1');
  // submit empty → errors
  await page.click('button[type=submit]');
  assert.ok(await page.locator('.fk-invalid').count() >= 5);
  await page.fill('#fk_name', 'Jules'); await page.fill('#fk_name_last', `Tan${tag}`);
  await page.fill('#fk_preferredName', 'Jules');
  await page.fill('#fk_dob', '2006-11-30');
  await page.fill('#fk_email', `jules.${tag}@example.com`);
  await page.fill('#fk_mobile', '303 555 0142');
  await page.check('input[name=fk_gender][value="Gender non-binary"]');
  assert.equal(await page.locator('[data-key=term]').isHidden(), true, 'term hidden until program chosen');
  await page.selectOption('#fk_program', 'Hawaii Summer Program');
  const termOpts = await page.locator('#fk_term option').allTextContents();
  assert.deepEqual(termOpts.slice(1).every((x) => x.startsWith('Summer')), true);
  await page.selectOption('#fk_term', 'Summer 2027');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Student Information Continued');
  await shot('2-step2-top');

  // step 2
  await page.fill('#fk_homeAddress_addr_line1', '12 Ocean Ave'); await page.fill('#fk_homeAddress_city', 'Santa Cruz');
  await page.fill('#fk_homeAddress_state', 'CA'); await page.fill('#fk_homeAddress_postal', '95060');
  await page.selectOption('#fk_homeCountry', 'United States');
  await page.check('input[name=fk_hasPassport][value=No]');
  assert.equal(await page.locator('[data-key=noPassportReason]').isVisible(), true);
  await page.fill('#fk_noPassportReason', 'Applying for one this month');
  await page.selectOption('#fk_schoolYear', 'High School Graduate');
  await page.fill('#fk_highSchool', 'Santa Cruz High'); await page.fill('#fk_university', 'NA');
  await page.check('input[name=fk_collegeCredit][value=No]');
  await page.fill('#fk_height', `5'9"`); await page.fill('#fk_weight', '150');
  await page.selectOption('#fk_swimming', 'Confident swimmer'); await page.selectOption('#fk_biking', 'Confident biker');
  for (const k of ['smoker', 'respiratory', 'migraines', 'skin', 'muscular', 'diabetes', 'claustrophobia', 'neurodevelopmental', 'allergies', 'mentalHealth', 'substance', 'physicalCondition', 'hospitalized']) {
    await page.check(`input[name=fk_${k}][value=No]`);
  }
  await page.check('input[name=fk_dietary][value=Yes]');
  assert.equal(await page.locator('[data-key=dietaryDetails]').isVisible(), true);
  await page.fill('#fk_dietaryDetails', 'Gluten free');
  await page.check('input[name=fk_covidVaccinated][value=Yes]');
  await page.fill('#fk_parent1Name', 'Kim'); await page.fill('#fk_parent1Name_last', 'Tan');
  await page.fill('#fk_parent1Phone', '831 555 0100'); await page.fill('#fk_parent1Email', 'kim@example.com');
  await page.fill('#fk_parent1Relationship', 'Mother');
  await page.fill('#fk_parent1Address_addr_line1', '12 Ocean Ave'); await page.fill('#fk_parent1Address_city', 'Santa Cruz');
  await page.selectOption('#fk_parent1Country', 'United States');
  await page.selectOption('#fk_foundUs', 'Gap Year Advisor or Independent Educational Consultant');
  await page.fill('#fk_advisorName', 'Pat Advisor');
  await page.selectOption('#fk_whoFound', 'You (the student)');
  await page.selectOption('#fk_shirtSize', 'Medium');
  await page.check('input[name=fk_criminalRecord][value=No]');
  // parent can't reuse the student's email
  await page.fill('#fk_parent1Email', `jules.${tag}@example.com`);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-key=parent1Email].fk-invalid');
  assert.match(await page.locator('[data-key=parent1Email] .fk-error').textContent(), /student's email/);
  await page.fill('#fk_parent1Email', 'kim@example.com');
  // submit without photo → error on photo
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-key=photo].fk-invalid');
  await page.setInputFiles('#fk_photo', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from('89504e47', 'hex') });
  await page.waitForSelector('.fk-filechip:not(.fk-busy)');
  await shot('3-step2-filled');
  await page.click('button[type=submit]');

  // interview
  await page.waitForSelector('iframe[title="Book your admissions interview"]');
  const frame = page.frameLocator('iframe[title="Book your admissions interview"]');
  assert.equal(await frame.locator('#who').textContent(), `jules.${tag}@example.com`, 'scheduler prefilled with email');
  await shot('4-interview');
  await frame.locator('#book').click();
  await page.waitForSelector('text=Pay your application fee', { timeout: 8000 });
  const total = await page.locator('.fee tr.total td:last-child').textContent();
  assert.equal(total, '$258.75');
  await shot('5-payment');

  // payment → (fake) Stripe → back
  let checkoutUrl;
  await page.route('https://checkout.stripe.com/**', (r) => { checkoutUrl = r.request().url(); r.fulfill({ body: 'stripe' }); });
  await page.click('#pay');
  await page.waitForURL(/checkout\.stripe\.com/);
  const sess = [...up.stripe.sessions.values()].pop();
  sess.payment_status = 'paid';
  await page.goto(sess.success_url.replace('{CHECKOUT_SESSION_ID}', sess.id));
  await page.waitForSelector('text=Application complete', { timeout: 10000 });
  assert.ok(!page.url().includes('token='), 'token stripped from the address bar');
  await shot('6-done');

  // reload resumes on the done screen
  await page.reload();
  await page.waitForSelector('text=Application complete');
  const [row] = (await pool.query(`SELECT * FROM applications WHERE email = $1`, [`jules.${tag}@example.com`])).rows;
  assert.equal(row.status, 'paid');
  assert.equal(row.answers.utm_source, 'instagram');
  assert.equal(row.answers.advisorName, 'Pat Advisor');
  assert.equal(up.crm.deals.get(row.hubspot_deal_id).properties.pipeline, '694619955');
  assert.deepEqual(errors, []);
  await page.close();
}

try {
  await run({ width: 1280, height: 900 }, 'desktop');
  console.log('  ✓ desktop flow');
  await run({ width: 390, height: 844 }, 'mobile');
  console.log('  ✓ mobile flow');
} finally {
  await browser.close(); server.close(); up.restore(); await pool.end();
}
