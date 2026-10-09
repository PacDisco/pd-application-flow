// Quiz + attribution: scoring, storage, HubSpot form submission with the
// visitor cookie, source properties (first touch kept), and step 1 of the
// application going through the HubSpot form before anything else.
// Needs the local Postgres used by flow.test.mjs (with MIGRATION-quiz.sql).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDb, fakeUpstreams } from './harness.mjs';
import { classify, sanitizeAttribution, attributionContactProps, realSource } from '../public/attribution-kit.mjs';
import { scoreQuiz, lintQuiz } from '../public/quiz-kit.mjs';

Object.assign(process.env, { HUBSPOT_TOKEN: 'x', JOTFORM_API_KEY: 'x', JOTFORM_MIRROR: 'on', HUBSPOT_SYNC: 'off', ADMISSIONS_ALERTS: 'off' });
delete process.env.URL; delete process.env.APPLY_SERVICE_KEY; // run syncs inline

const appSchema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
const quizSeed = JSON.parse(readFileSync(new URL('../scripts/quiz-seed.json', import.meta.url)));
const { pool } = await setupDb(appSchema);
const up = fakeUpstreams();
const quiz = (await import('../netlify/functions/quiz.mjs')).default;
const apply = (await import('../netlify/functions/apply.mjs')).default;
const { __resetQuizCache } = await import('../netlify/functions/_lib/quiz.mjs');
const { __setTransport } = await import('../netlify/functions/_lib/notify.mjs');
__setTransport({ sendMail: async () => ({}) });

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const call = async (fn, base, path, body, method = 'POST', ip = '10.0.0.9') => {
  const res = await fn(new Request(`https://apply.example.org/api/${base}/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), { ip });
  return { status: res.status, body: await res.json() };
};
const HUTK = 'a'.repeat(32);
const contactByEmail = (e) => [...up.crm.contacts.values()].find((c) => c.properties.email === e);

const answers = {
  motivation: 'Cultural immersion — I want to live and learn alongside locals.',
  feelAtEnd: 'Connected to a new culture and community',
  travelExcites: 'Trying new foods and languages',
  idealDay: 'Living with a host family, learning local customs',
  offGrid: 'A bit nervous but I’d adapt',
  climate: 'Variable – I’m happy anywhere as long as it’s new',
  groupRole: 'The connector – I bring people together',
  challenge: 'Look for help or guidance',
  learnStyle: 'Immersed in local culture',
  topic: 'Language and cultural studies',
  experience: 'Volunteering or community homestays',
  credit: 'It’s a bonus, but not required',
  travelLength: '10 weeks (Semester)',
  travelWhen: 'Fall 2027',
  regions: ['Japan', 'Southeast Asia (Bali, Thailand, Vietnam, Cambodia)'],
};
const who = { name: { first: 'Lena', last: 'Park' }, email: 'lena@example.com', mobile: { cc: '1', number: '303 555 0144' } };
const attr = {
  first: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'gap-year-2027', gclid: 'G-1', landing: 'https://www.pacificdiscovery.org/gap-year/', ts: '2026-09-01' },
  last: { referrer: 'https://www.instagram.com/', landing: 'https://apply.pacificdiscovery.org/quiz', ts: '2026-10-01' },
  hutk: HUTK, pageUri: 'https://apply.pacificdiscovery.org/quiz', pageName: 'Gap Year Quiz',
};

await t('attribution: channels', () => {
  assert.equal(classify({ gclid: 'x' }).channel, 'Paid Search');
  assert.equal(classify({ utm_source: 'facebook', utm_medium: 'paid_social' }).channel, 'Paid Social');
  assert.equal(classify({ utm_source: 'ig', utm_medium: 'cpc' }).channel, 'Paid Social');
  assert.equal(classify({ utm_source: 'hs_email', utm_medium: 'email' }).channel, 'Email Marketing');
  assert.equal(classify({ referrer: 'https://www.google.com/' }).channel, 'Organic Search');
  assert.equal(classify({ referrer: 'https://chatgpt.com/' }).channel, 'AI Referrals');
  assert.equal(classify({ referrer: 'https://l.instagram.com/' }).channel, 'Organic Social');
  assert.equal(classify({ referrer: 'https://www.gooverseas.com/gap-year' }).channel, 'Referrals');
  assert.equal(classify({ fbclid: 'abc' }).channel, 'Organic Social');
  assert.equal(classify({ utm_source: 'teenlife', utm_medium: 'referral' }).channel, 'Referrals');
  assert.equal(classify({}).channel, 'Direct Traffic');
});

await t('attribution: sanitising + first touch is never overwritten', () => {
  const a = sanitizeAttribution({ ...attr, hutk: 'not-a-cookie', evil: '<x>' });
  assert.equal(a.hutk, undefined);
  assert.equal(a.first.utm_campaign, 'gap-year-2027');
  const legacy = sanitizeAttribution({ utm_source: 'newsletter', landing: 'https://apply.pacificdiscovery.org/' });
  assert.equal(legacy.first.utm_source, 'newsletter');
  const fresh = attributionContactProps(sanitizeAttribution(attr), {}, { conversion: 'Gap year quiz' });
  assert.equal(fresh.pd_first_channel, 'Paid Search');
  assert.equal(fresh.pd_first_click_id, 'gclid:G-1');
  assert.equal(fresh.pd_last_channel, 'Organic Social');
  assert.equal(fresh.pd_first_conversion, 'Gap year quiz');
  const again = attributionContactProps(sanitizeAttribution(attr), { pd_first_channel: 'Referrals', pd_first_conversion: 'Old form' }, { conversion: 'Application (step 1)' });
  assert.equal(again.pd_first_channel, undefined);
  assert.equal(again.pd_first_conversion, undefined);
  assert.equal(again.pd_last_conversion, 'Application (step 1)');
});

await t('real source: HubSpot unless Offline, then site cookie, then drill-downs', () => {
  assert.equal(realSource({ contact: { hs_analytics_source: 'ORGANIC_SEARCH' } }).channel, 'Organic Search');
  const s = realSource({ contact: { hs_analytics_source: 'OFFLINE' }, siteFirst: { gclid: 'x' } });
  assert.deepEqual([s.channel, s.basis, s.hubspot], ['Paid Search', 'site', 'Offline Sources']);
  const r = realSource({ contact: { hs_analytics_source: 'OFFLINE', original_source_drill_down_3: 'adwords' }, recover: (d3) => (d3 === 'adwords' ? { channel: 'Paid Search', detail: 'adwords' } : null) });
  assert.equal(r.basis, 'recovered');
  assert.equal(realSource({ contact: { hs_analytics_source: 'OFFLINE' } }).channel, 'Unknown (offline)');
});

await t('quiz seed: lint clean; scoring matches the Jotform rules', () => {
  assert.deepEqual(lintQuiz(quizSeed).filter((l) => l.level === 'error'), []);
  const s = scoreQuiz(quizSeed, answers);
  assert.equal(s.archetype, 'connector');
  assert.equal(s.scores.connector, 7); // q5,q7,q22,q25,q32,q33 + regions (once)
  assert.equal(s.scores.changemaker, 3); // q7 connected, q25 nervous, regions SEA (once)
  // ties go to the earlier result in the list
  assert.equal(scoreQuiz(quizSeed, {}).archetype, 'adventurer');
});

await t('schema: bundled quiz until one is published; integration details hidden', async () => {
  const r = await call(quiz, 'quiz', 'schema', null, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.body.schema.kind, 'quiz');
  assert.equal(r.body.schema.settings.hubspotFormGuid, undefined);
  assert.ok(!JSON.stringify(r.body).includes('"hubspot"'));
  assert.ok(r.body.schema.steps[0].sections[0].fields[0].scores, 'scores are public so ?preview=1 can score locally');
});

await t('submit: every question required; max 2 regions', async () => {
  const r = await call(quiz, 'quiz', 'submit', { values: { ...who, motivation: answers.motivation } });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.feelAtEnd);
  const r2 = await call(quiz, 'quiz', 'submit', { values: { ...answers, ...who, regions: ['Japan', 'Southeast Asia (Bali, Thailand, Vietnam, Cambodia)', 'South America (Peru, Ecuador, Galapagos)'] } });
  assert.equal(r2.status, 422);
  assert.match(r2.body.errors.regions, /up to 2/);
});

await t('submit with a HubSpot form: form first (with cookie), then source + quiz properties', async () => {
  const published = JSON.parse(JSON.stringify(quizSeed));
  published.settings.hubspotFormGuid = 'quiz-guid-1';
  await pool.query(`INSERT INTO apply_forms (id, draft, published, published_rev) VALUES ('pd-quiz', $1, $1, 3)`, [JSON.stringify(published)]);
  __resetQuizCache();
  const r = await call(quiz, 'quiz', 'submit', { values: { ...answers, ...who }, attribution: attr });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.archetype, 'connector');
  assert.equal(r.body.result.name, 'The Cultural Connector');
  const sub = up.crm.formSubs.find((s) => s.path.endsWith('/quiz-guid-1'));
  assert.ok(sub, 'submitted to the HubSpot form');
  assert.ok(sub.path.includes('/secure/submit/3855728/'));
  assert.equal(sub.context.hutk, HUTK);
  assert.equal(sub.context.pageUri, 'https://apply.pacificdiscovery.org/quiz');
  const c = contactByEmail('lena@example.com');
  assert.equal(c.properties.hs_analytics_source, 'PAID_SEARCH', 'contact was created by the form, so HubSpot attributed it');
  assert.equal(c.properties.pd_first_channel, 'Paid Search');
  assert.equal(c.properties.pd_first_campaign, 'gap-year-2027');
  assert.equal(c.properties.pd_last_channel, 'Organic Social');
  assert.equal(c.properties.pd_quiz_archetype, 'The Cultural Connector');
  assert.match(c.properties.pd_quiz_answers, /What is your motivation/);
  assert.equal(c.properties.hs_lead_status, 'NEW');
  assert.equal(c.properties.phone, '+1 303 555 0144');
  const [row] = (await pool.query(`SELECT * FROM quiz_responses WHERE email = 'lena@example.com'`)).rows;
  assert.equal(row.archetype, 'connector');
  assert.equal(row.hubspot_contact_id, c.id);
  assert.equal(row.sync.hubspot.ok, true);
  assert.equal(row.sync.form.ok, true);
});

await t('second quiz: first touch and working lead status are kept', async () => {
  const c = contactByEmail('lena@example.com');
  c.properties.hs_lead_status = 'IN_PROGRESS';
  const r = await call(quiz, 'quiz', 'submit', { values: { ...answers, ...who, motivation: 'Adventure and fun — I want to see and do new things!' }, attribution: { last: { utm_source: 'newsletter', utm_medium: 'email' }, hutk: HUTK } });
  assert.equal(r.status, 200);
  assert.equal(c.properties.pd_first_channel, 'Paid Search');
  assert.equal(c.properties.pd_last_channel, 'Email Marketing');
  assert.equal(c.properties.hs_lead_status, 'IN_PROGRESS');
});

await t('form missing a field: retried with the email alone', async () => {
  up.crm.formReject = true;
  const r = await call(quiz, 'quiz', 'submit', { values: { ...answers, ...who, email: 'sam@example.com', name: { first: 'Sam', last: 'Lee' } }, attribution: attr });
  up.crm.formReject = false;
  assert.equal(r.status, 200);
  const subs = up.crm.formSubs.filter((s) => s.fields.some((f) => f.value === 'sam@example.com'));
  assert.equal(subs.length, 2);
  assert.equal(subs[1].fields.length, 1);
  const c = contactByEmail('sam@example.com');
  assert.equal(c.properties.firstname, 'Sam', 'the CRM write fills in what the form could not take');
  assert.equal(c.properties.pd_quiz_archetype, 'The Cultural Connector');
});

await t('application step 1: HubSpot form before the Jotform mirror; source written', async () => {
  const s = JSON.parse(JSON.stringify(appSchema));
  s.settings.hubspotFormGuid = 'app-guid-1';
  await pool.query(`UPDATE apply_forms SET published = $1 WHERE id = 'pd-application'`, [JSON.stringify(s)]);
  const { publishedSchema } = await import('../netlify/functions/_lib/db.mjs');
  await publishedSchema({ fresh: true });
  up.calls.length = 0;
  const r = await call(apply, 'apply', 'start', {
    values: { name: { first: 'Ava', last: 'Cole' }, preferredName: 'Ava', dob: '2007-01-02', email: 'ava@example.com', mobile: { cc: '1', number: '720 555 0101' }, gender: 'Female', program: 'South America Gap Semester', term: 'Spring 2027' },
    attribution: { ...attr, utm_source: 'google' },
  }, 'POST', '10.0.0.20');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const iForm = up.calls.findIndex((c) => c.host === 'api.hsforms.com');
  const iJot = up.calls.findIndex((c) => c.host === 'api.jotform.com');
  assert.ok(iForm >= 0, 'form submitted');
  assert.ok(iJot < 0 || iForm < iJot, 'form goes before the Jotform mirror (which can fire the old Zap)');
  const c = contactByEmail('ava@example.com');
  assert.equal(c.properties.hs_analytics_source, 'PAID_SEARCH');
  assert.equal(c.properties.pd_first_channel, 'Paid Search');
  assert.equal(c.properties.pd_last_conversion, 'Application (step 1)');
  assert.equal(c.properties.mobilephone, '+1 720 555 0101');
  const [app] = (await pool.query(`SELECT sync, attribution FROM applications WHERE email = 'ava@example.com'`)).rows;
  assert.equal(app.sync.hsSource.ok, true);
  assert.equal(app.attribution.hutk, HUTK);
});

console.log(`\n${n} passed`);
await pool.end();
