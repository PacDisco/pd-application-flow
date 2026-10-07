// End-to-end through the real handlers: step 1 → upload → step 2 → interview →
// checkout → paid (return page + webhook) → HubSpot / Jotform side effects →
// service API (what the portals read) → portal edit.
// Needs a local Postgres with MIGRATION-apply.sql applied (TEST_PG_URL).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setupDb, memoryStore, fakeUpstreams } from './harness.mjs';

Object.assign(process.env, {
  HUBSPOT_TOKEN: 'x', JOTFORM_API_KEY: 'x', STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  APPLY_SERVICE_KEY: 'svc', APPLY_SITE_URL: 'https://apply.example.org', URL: 'https://apply.example.org',
  JOTFORM_MIRROR: 'on', HUBSPOT_SYNC: 'on',
});

const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
schema.programs.find((p) => p.name === 'South America Gap Semester').pdProgram = 'South America Semester';
const { pool } = await setupDb(schema);
globalThis.__applyTestStore = memoryStore();
const up = fakeUpstreams();
const apply = (await import('../netlify/functions/apply.mjs')).default;
const service = (await import('../netlify/functions/service.mjs')).default;
const webhook = (await import('../netlify/functions/stripe-webhook.mjs')).default;
const file = (await import('../netlify/functions/file.mjs')).default;

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const call = async (path, body, method = 'POST') => {
  const res = await apply(new Request(`https://apply.example.org/api/apply/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), { ip: '10.0.0.1' });
  return { status: res.status, body: await res.json() };
};

const step1 = {
  name: { first: 'Maya', last: 'Ortiz' }, preferredName: 'Maya', dob: '2007-02-03', email: 'maya@example.com',
  mobile: { cc: '1', number: '720 555 0199' }, gender: 'Female', pronouns: 'she/her',
  program: 'South America Gap Semester', term: 'Spring 2027', utm_source: 'google', gclid: 'g-1',
};
const step2 = {
  homeAddress: { addr_line1: '1 Pearl St', city: 'Boulder', state: 'CO', postal: '80302' }, homeCountry: 'United States',
  hasPassport: 'Yes', passportCountry: 'United States', passportExpiry: '2031-05-01',
  schoolYear: 'High School - Senior', highSchool: 'Boulder High', university: 'NA', collegeCredit: 'Unsure',
  height: `5'6"`, weight: '130', swimming: 'Confident swimmer', biking: 'Moderate biker',
  smoker: 'No', respiratory: 'Yes', respiratoryDetails: 'Mild asthma, inhaler', migraines: 'No', skin: 'No', muscular: 'No', diabetes: 'No',
  claustrophobia: 'No', neurodevelopmental: 'No', allergies: 'No', dietary: 'Yes', dietaryDetails: 'Vegetarian', mentalHealth: 'No',
  substance: 'No', physicalCondition: 'No', hospitalized: 'No', covidVaccinated: 'Yes',
  parent1Name: { first: 'Rosa', last: 'Ortiz' }, parent1Phone: { cc: '1', number: '720 555 0100' }, parent1Email: 'rosa@example.com',
  parent1Relationship: 'Mother', parent1Address: { addr_line1: '1 Pearl St', city: 'Boulder', state: 'CO', postal: '80302' }, parent1Country: 'United States',
  foundUs: 'Word of Mouth', referralName: 'Sam Lee', whoFound: 'Your parents', shirtSize: 'Small', criminalRecord: 'No',
};

let token, appId;

await t('schema endpoint hides integration details', async () => {
  const r = await call('schema', null, 'GET');
  assert.equal(r.status, 200);
  const f = r.body.schema.steps[0].sections[0].fields.find((x) => x.key === 'email');
  assert.equal(f.jf, undefined); assert.equal(f.hubspot, undefined);
  assert.equal(r.body.schema.fee.total, 258.75);
  assert.equal(r.body.schema.settings.jotform, undefined);
});

await t('step 1 rejects bad input with field errors', async () => {
  const r = await call('start', { values: { ...step1, email: 'nope', term: 'Summer 2027' } });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.email && r.body.errors.term);
});

await t('step 1 creates the application, mirrors to Jotform and HubSpot', async () => {
  const r = await call('start', { values: step1, attribution: { utm_source: 'google', landing: 'https://www.pacificdiscovery.org/apply' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
  assert.equal(r.body.status.step, 'step2');
  const [row] = (await pool.query('SELECT * FROM applications')).rows;
  appId = row.id;
  assert.equal(row.email, 'maya@example.com');
  assert.equal(row.season, 'Spring'); assert.equal(row.travel_year, '2027'); assert.equal(row.program_type, 'semester');
  assert.ok(row.jotform_step1_id, 'jotform step1 mirrored');
  const sub = up.jot.subs.get(row.jotform_step1_id);
  assert.equal(sub.form, '251668678208874');
  assert.equal(sub.params['submission[16]'], 'maya@example.com');
  assert.equal(sub.params['submission[120]'], 'Spring 2027');
  assert.equal(sub.params['submission[127]'], '15500');
  assert.equal(sub.params['submission[128]'], 'google');
  const contact = up.crm.contacts.get(row.hubspot_contact_id);
  assert.equal(contact.properties.firstname, 'Maya');
  assert.equal(contact.properties.mobilephone, '+1 720 555 0199');
  const deal = up.crm.deals.get(row.hubspot_deal_id);
  assert.equal(deal.properties.pipeline, '1'); assert.equal(deal.properties.dealstage, 'a1');
  assert.equal(deal.properties.pd_program, 'South America Semester');
  assert.equal(deal.properties.travel_year, '2027'); assert.equal(deal.properties.amount, '15500');
  assert.equal(deal.properties.dealname, 'Maya Ortiz - South America Gap Semester');
});

await t('cannot skip ahead to payment', async () => {
  const r = await call('checkout', { token });
  assert.equal(r.status, 409);
});

let photo;
await t('photo upload is stored against the application', async () => {
  const fd = new FormData();
  fd.append('token', token); fd.append('field', 'photo');
  fd.append('file', new Blob([Buffer.from('fakejpeg')], { type: 'image/jpeg' }), 'me.jpg');
  const res = await apply(new Request('https://apply.example.org/api/apply/upload', { method: 'POST', body: fd }), {});
  photo = await res.json();
  assert.equal(res.status, 200, JSON.stringify(photo));
  assert.equal(photo.name, 'me.jpg');
  const fd2 = new FormData();
  fd2.append('token', token); fd2.append('field', 'photo');
  fd2.append('file', new Blob([Buffer.from('x')], { type: 'application/pdf' }), 'x.pdf');
  const bad = await apply(new Request('https://apply.example.org/api/apply/upload', { method: 'POST', body: fd2 }), {});
  assert.equal(bad.status, 400);
});

await t('step 2 validates conditionals server-side', async () => {
  const { respiratoryDetails, ...missing } = step2;
  const r = await call('step2', { token, values: { ...missing, photo: [photo] } });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.respiratoryDetails);
});

await t('step 2 saves, mirrors the full application, moves the deal', async () => {
  const r = await call('step2', { token, values: { ...step2, photo: [photo], program: 'HACK' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status.step, 'interview');
  const [row] = (await pool.query('SELECT * FROM applications WHERE id = $1', [appId])).rows;
  assert.equal(row.answers.program, 'South America Gap Semester', 'step 2 cannot overwrite step-1 answers');
  const sub = up.jot.subs.get(row.jotform_step2_id);
  assert.equal(sub.form, '240277257210046');
  assert.equal(sub.params['submission[4][first]'], 'Maya');
  assert.equal(sub.params['submission[16]'], 'maya@example.com');
  assert.equal(sub.params['submission[135]'], '+1 720 555 0199');
  assert.equal(sub.params['submission[136]'], '02-03-2007');
  assert.equal(sub.params['submission[122]'], 'Mild asthma, inhaler');
  assert.equal(sub.params['submission[13][city]'], 'Boulder');
  assert.equal(sub.params['submission[92]'], `https://apply.example.org/api/file/${photo.id}`);
  assert.equal(sub.params['submission[138][year]'], '2031');
  assert.equal(up.crm.deals.get(row.hubspot_deal_id).properties.dealstage, 'a2');
  assert.equal(up.crm.contacts.get(row.hubspot_contact_id).properties.word_of_mouth_referral_name, 'Sam Lee');
  // jotform-shaped copy for the portals
  assert.equal(row.jf_step2.answers['88'].answer, 'Small');
  assert.equal(row.jf_step2.answers['92'].type, 'control_fileupload');
  assert.ok(!('128' in row.jf_step2.answers));
});

await t('status never returns step-2 answers', async () => {
  const r = await call(`status?token=${token}`, null, 'GET');
  assert.equal(r.body.step, 'interview');
  assert.ok(!JSON.stringify(r.body).includes('asthma'));
});

await t('interview booking advances and notes HubSpot', async () => {
  const r = await call('interview', { token, booking: { start: '1790000000000', label: 'Tuesday, October 13, 2026 at 9:00 AM' } });
  assert.equal(r.body.status.step, 'payment');
  assert.equal(up.crm.notes.length, 1);
});

let session;
await t('checkout: $250 + $8.75 card fee', async () => {
  const r = await call('checkout', { token });
  assert.equal(r.status, 200);
  session = [...up.stripe.sessions.values()].pop();
  assert.equal(session.amount_total, 25875);
  assert.equal(session.form.get('line_items[0][price_data][unit_amount]'), '25000');
  assert.equal(session.form.get('line_items[1][price_data][unit_amount]'), '875');
  assert.equal(session.client_reference_id, appId);
  assert.equal(session.metadata.processing_fee_rate, '0.035');
  assert.ok(session.success_url.includes('session_id={CHECKOUT_SESSION_ID}'));
});

await t('returning from Stripe marks paid and moves the deal to Spring Semester', async () => {
  session.payment_status = 'paid';
  const r = await call(`status?token=${token}&session_id=${session.id}`, null, 'GET');
  assert.equal(r.body.paid, true); assert.equal(r.body.step, 'done');
  const [row] = (await pool.query('SELECT * FROM applications WHERE id = $1', [appId])).rows;
  assert.equal(row.payment.total, 258.75); assert.equal(row.payment.base, 250); assert.equal(row.payment.surcharge, 8.75);
  const deal = up.crm.deals.get(row.hubspot_deal_id).properties;
  assert.equal(deal.pipeline, '74759274');
  assert.equal(deal.dealstage, 'p9');
  assert.equal(deal.pd_program, 'South America Semester');
  assert.equal(deal.travel_year, '2027');
  assert.match(deal.payment_1, new RegExp(`^250, pi_${session.id}, \\d{4}-\\d{2}-\\d{2}$`));
  assert.equal(row.sync.hsPaid.ok, true);
});

await t('webhook replay is idempotent (no second payment_N)', async () => {
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${payload}`).digest('hex');
  const res = await webhook(new Request('https://apply.example.org/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, body: payload }));
  const out = await res.json();
  assert.equal(out.first, false);
  const [row] = (await pool.query('SELECT * FROM applications WHERE id = $1', [appId])).rows;
  assert.ok(!up.crm.deals.get(row.hubspot_deal_id).properties.payment_2);
  const bad = await webhook(new Request('https://apply.example.org/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=deadbeef` }, body: payload }));
  assert.equal(bad.status, 400);
});

const svc = (path, init = {}) => service(new Request(`https://apply.example.org/api/service/${path}`, { ...init, headers: { 'x-apply-key': 'svc', ...(init.headers || {}) } }));

await t('service API: Jotform-shaped submissions for the portals', async () => {
  const denied = await service(new Request('https://apply.example.org/api/service/submissions?form=240277257210046'));
  assert.equal(denied.status, 403);
  const r = await (await svc('submissions?form=240277257210046&email=MAYA@example.com')).json();
  assert.equal(r.content.length, 1);
  const s = r.content[0];
  assert.ok(s.id.startsWith('pda_'));
  assert.equal(s.form_id, '240277257210046');
  assert.equal(s.answers['16'].answer, 'maya@example.com');
  assert.equal(s.answers['16'].type, 'control_email');
  assert.equal(s.answers['81'].name, 'pleaseLet');
  assert.deepEqual(s.answers['92'].answer, [`https://apply.example.org/api/file/${photo.id}`]);
  assert.ok(s.jotform_id);
  const r1 = await (await svc('submissions?form=251668678208874')).json();
  assert.equal(r1.content[0].answers['120'].answer, 'Spring 2027');
});

await t('service API: portal edit updates answers + mirrors to Jotform', async () => {
  const pid = `pda_${appId}`;
  const res = await svc(`submission/${pid}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'submission[27]=Fairview High&submission[13][city]=Louisville&submission[14]=%2B64 21 555 123' });
  assert.equal(res.status, 200);
  const [row] = (await pool.query('SELECT * FROM applications WHERE id = $1', [appId])).rows;
  assert.equal(row.answers.highSchool, 'Fairview High');
  assert.equal(row.answers.homeAddress.city, 'Louisville');
  assert.deepEqual(row.answers.mobile, { cc: '64', number: '21 555 123' });
  assert.equal(row.jf_step2.answers['135'].answer, '+64 21 555 123');
  assert.equal(up.jot.subs.get(row.jotform_step2_id).params['submission[27]'], 'Fairview High');
});

await t('file endpoint requires the service key', async () => {
  const no = await file(new Request(`https://apply.example.org/api/file/${photo.id}`), { params: { id: photo.id } });
  assert.equal(no.status, 403);
  const yes = await file(new Request(`https://apply.example.org/api/file/${photo.id}`, { headers: { 'x-apply-key': 'svc' } }), { params: { id: photo.id } });
  assert.equal(yes.status, 200);
  assert.equal(Buffer.from(await yes.arrayBuffer()).toString(), 'fakejpeg');
});

await t('Zap mode (HUBSPOT_SYNC=off): payment still finds the Zap-made deal', async () => {
  process.env.HUBSPOT_SYNC = 'off'; process.env.JOTFORM_MIRROR = 'off';
  // the Zap made a contact + deal in PD Applications
  up.crm.contacts.set('900', { id: '900', properties: { email: 'leo@example.com' } });
  up.crm.deals.set('901', { id: '901', properties: { dealname: 'Leo Park - Bali Summer Program', pipeline: '1', dealstage: 'a1', createdate: new Date().toISOString() } });
  up.crm.assoc.set('900', ['901']);
  const s1 = await call('start', { values: { ...step1, email: 'leo@example.com', name: { first: 'Leo', last: 'Park' }, program: 'Bali Summer Program', term: 'Summer 2027' } });
  const tok = s1.body.token;
  const [row0] = (await pool.query(`SELECT * FROM applications WHERE email = 'leo@example.com'`)).rows;
  assert.equal(row0.hubspot_deal_id, null); assert.equal(row0.jotform_step1_id, null);
  await call('step2', { token: tok, values: { ...step2, photo: [] } }).then((r) => assert.equal(r.status, 422)); // photo required
  const fd = new FormData(); fd.append('token', tok); fd.append('field', 'photo'); fd.append('file', new Blob([Buffer.from('p')], { type: 'image/png' }), 'p.png');
  const ph = await (await apply(new Request('https://apply.example.org/api/apply/upload', { method: 'POST', body: fd }), {})).json();
  assert.equal((await call('step2', { token: tok, values: { ...step2, photo: [ph] } })).status, 200);
  await call('interview', { token: tok, booking: { label: 'soon' } });
  await call('checkout', { token: tok });
  const sess = [...up.stripe.sessions.values()].pop();
  sess.payment_status = 'paid';
  const st = await call(`status?token=${tok}&session_id=${sess.id}`, null, 'GET');
  assert.equal(st.body.paid, true);
  const deal = up.crm.deals.get('901').properties;
  assert.equal(deal.pipeline, '694619955'); assert.equal(deal.dealstage, 's9');
  assert.equal(deal.pd_program, 'Bali Summer Program'); assert.equal(deal.travel_year, '2027');
  assert.ok(deal.payment_1.startsWith('250, pi_'));
  process.env.HUBSPOT_SYNC = 'on'; process.env.JOTFORM_MIRROR = 'on';
});

await t('Zap mode: full application with no payment lands in PD Applications / Application Complete', async () => {
  process.env.HUBSPOT_SYNC = 'off'; process.env.JOTFORM_MIRROR = 'off';
  // Zap made the contact + a deal, but in the wrong pipeline
  up.crm.contacts.set('950', { id: '950', properties: { email: 'nia@example.com' } });
  up.crm.deals.set('951', { id: '951', properties: { dealname: 'Nia Brooks - Costa Rica Mini Semester', pipeline: '74958085', dealstage: 'fm9', createdate: new Date().toISOString() } });
  up.crm.assoc.set('950', ['951']);
  const s1 = await call('start', { values: { ...step1, email: 'nia@example.com', name: { first: 'Nia', last: 'Brooks' }, program: 'Costa Rica Mini Semester', term: 'Fall 2027' } });
  const tok = s1.body.token;
  const fd = new FormData(); fd.append('token', tok); fd.append('field', 'photo'); fd.append('file', new Blob([Buffer.from('p')], { type: 'image/png' }), 'p.png');
  const ph = await (await apply(new Request('https://apply.example.org/api/apply/upload', { method: 'POST', body: fd }), {})).json();
  assert.equal((await call('step2', { token: tok, values: { ...step2, photo: [ph] } })).status, 200);
  const d = up.crm.deals.get('951').properties;
  assert.equal(d.pipeline, '1'); assert.equal(d.dealstage, 'a2');
  assert.equal(d.travel_year, '2027'); assert.equal(d.amount, '10500');
  const [row] = (await pool.query(`SELECT * FROM applications WHERE email = 'nia@example.com'`)).rows;
  assert.equal(row.hubspot_deal_id, '951'); assert.equal(row.sync.hsStep2.pipeline, 'PD Applications');

  // no Zap deal at all → one is created in PD Applications
  const s2 = await call('start', { values: { ...step1, email: 'omar@example.com', name: { first: 'Omar', last: 'Diaz' } } });
  const fd2 = new FormData(); fd2.append('token', s2.body.token); fd2.append('field', 'photo'); fd2.append('file', new Blob([Buffer.from('p')], { type: 'image/png' }), 'p.png');
  const ph2 = await (await apply(new Request('https://apply.example.org/api/apply/upload', { method: 'POST', body: fd2 }), {})).json();
  await call('step2', { token: s2.body.token, values: { ...step2, photo: [ph2] } });
  const [r2] = (await pool.query(`SELECT * FROM applications WHERE email = 'omar@example.com'`)).rows;
  const d2 = up.crm.deals.get(r2.hubspot_deal_id).properties;
  assert.equal(d2.pipeline, '1'); assert.equal(d2.dealstage, 'a2'); assert.equal(d2.dealname, 'Omar Diaz - South America Gap Semester');
  process.env.HUBSPOT_SYNC = 'on'; process.env.JOTFORM_MIRROR = 'on';
});

await t('rate limit: 8 applications per IP per hour', async () => {
  let last;
  for (let i = 0; i < 12; i += 1) last = await call('start', { values: { ...step1, email: `x${i}@example.com` } });
  assert.equal(last.status, 429);
});

up.restore();
await pool.end();
console.log(`\n${n} passed`);
