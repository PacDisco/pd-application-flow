// node test/tracking.test.mjs — ad tracking config + Meta Conversions API payloads (no services needed)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as T from '../netlify/functions/_lib/tracking.mjs';
import { sanitizeAttribution } from '../public/attribution-kit.mjs';
import trackingConfig from '../netlify/functions/tracking-config.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const KEYS = ['TRACKING', 'META_PIXEL_ID', 'META_CAPI_TOKEN', 'META_TEST_EVENT_CODE', 'GA4_MEASUREMENT_ID', 'GOOGLE_ADS_ID', 'GOOGLE_ADS_LABELS', 'TIKTOK_PIXEL_ID', 'GTM_ID'];
const setEnv = (o) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, o); };

await t('browser config: only valid IDs, never the CAPI token', () => {
  setEnv({ META_PIXEL_ID: '123456789012345', META_CAPI_TOKEN: 'secret', GA4_MEASUREMENT_ID: 'G-ABC1234', GOOGLE_ADS_ID: 'AW-1234567890',
    GOOGLE_ADS_LABELS: 'quiz_lead=AbC123xyz, application_fee_paid=GhI789abc, nonsense=zzzzzz', TIKTOK_PIXEL_ID: 'not valid!', GTM_ID: 'GTM-ABC123' });
  const c = T.browserConfig();
  assert.deepEqual(c, { meta: '123456789012345', ga4: 'G-ABC1234', ads: 'AW-1234567890', adsLabels: { quiz_lead: 'AbC123xyz', application_fee_paid: 'GhI789abc' }, gtm: 'GTM-ABC123' });
  assert.ok(!JSON.stringify(c).includes('secret'));
});

await t('TRACKING=off switches everything off', async () => {
  setEnv({ TRACKING: 'off', META_PIXEL_ID: '123456789012345', META_CAPI_TOKEN: 'x' });
  assert.deepEqual(T.browserConfig(), { off: true });
  assert.equal((await T.sendMeta({ event_name: 'Lead' })).skipped, 'meta not configured');
});

await t('/tracking-config.js serves a script', async () => {
  setEnv({ META_PIXEL_ID: '123456789012345' });
  const res = await trackingConfig(new Request('http://x/tracking-config.js'));
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await res.text(), 'window.PD_TRACKING={"meta":"123456789012345","adsLabels":{}};\n');
});

await t('attribution keeps valid ad cookies only', () => {
  const a = sanitizeAttribution({ ads: { fbp: 'fb.1.1700000000000.1234567890', fbc: 'fb.1.1700000000000.IwAR0abc-DEF_1', ttp: '<script>' } });
  assert.deepEqual(a.ads, { fbp: 'fb.1.1700000000000.1234567890', fbc: 'fb.1.1700000000000.IwAR0abc-DEF_1' });
  assert.equal(sanitizeAttribution({ ads: { fbp: 'evil' } }).ads, undefined);
});

await t('fbc rebuilt from the fbclid the attribution cookie kept', () => {
  assert.equal(T.fbcFor({ last: { fbclid: 'IwAR0xyz', ts: '2026-10-15' } }), `fb.1.${Date.parse('2026-10-15')}.IwAR0xyz`);
  assert.equal(T.fbcFor({ ads: { fbc: 'fb.1.1.abc' }, last: { fbclid: 'other' } }), 'fb.1.1.abc');
  assert.equal(T.fbcFor({}), undefined);
});

await t('CAPI event: hashed, normalised user data; dedupe ID; no raw PII', () => {
  const ev = T.buildMetaEvent({
    name: 'Lead', eventId: 'quiz_abc12345', time: '2026-10-15T00:00:00Z', sourceUrl: 'https://apply.pacificdiscovery.org/quiz',
    person: { email: ' Jane@Example.COM ', phone: '+1 (303) 555-0100', first: 'Jane', last: 'Doe', externalId: 'jane@example.com' },
    attr: { ads: { fbp: 'fb.1.1700000000000.42' }, last: { fbclid: 'IwAR0xyz', ts: '2026-10-14' } },
    ip: '203.0.113.9', userAgent: 'UA', custom: { content_name: 'Gap year quiz', archetype: 'seeker', empty: '' },
  });
  assert.equal(ev.event_name, 'Lead');
  assert.equal(ev.event_id, 'quiz_abc12345');
  assert.equal(ev.action_source, 'website');
  assert.equal(ev.event_time, Date.parse('2026-10-15T00:00:00Z') / 1000);
  assert.deepEqual(ev.user_data.em, [sha('jane@example.com')]);
  assert.deepEqual(ev.user_data.ph, [sha('13035550100')]);
  assert.deepEqual(ev.user_data.fn, [sha('jane')]);
  assert.equal(ev.user_data.fbp, 'fb.1.1700000000000.42');
  assert.ok(ev.user_data.fbc.endsWith('.IwAR0xyz'));
  assert.equal(ev.user_data.client_ip_address, '203.0.113.9');
  assert.deepEqual(ev.custom_data, { content_name: 'Gap year quiz', archetype: 'seeker' });
  assert.ok(!JSON.stringify(ev).toLowerCase().includes('jane@'));
});

await t('event IDs: browser IDs validated; fee ID stable and not the app id', () => {
  assert.equal(T.cleanEventId('start_1b4e28ba-2fa1-11d2-883f-0016d3cca427'), 'start_1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.equal(T.cleanEventId('x'), null);
  assert.equal(T.cleanEventId('<script>alert(1)</script>'), null);
  const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  assert.equal(T.feeEventId(id), T.feeEventId(id));
  assert.ok(!T.feeEventId(id).includes(id));
});

await t('sendMeta posts to the Graph API with the test code; never throws', async () => {
  setEnv({ META_PIXEL_ID: '123456789012345', META_CAPI_TOKEN: 'tok', META_TEST_EVENT_CODE: 'TEST1' });
  const real = globalThis.fetch; let seen;
  globalThis.fetch = async (u, init) => { seen = { u: String(u), body: JSON.parse(init.body) }; return new Response('{"events_received":1}', { status: 200 }); };
  try {
    assert.deepEqual(await T.sendMeta({ event_name: 'Lead' }), { ok: true, received: 1 });
    assert.match(seen.u, /^https:\/\/graph\.facebook\.com\/v\d+\.\d\/123456789012345\/events\?access_token=tok$/);
    assert.equal(seen.body.test_event_code, 'TEST1');
    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal((await T.sendMeta({ event_name: 'Lead' })).ok, false);
  } finally { globalThis.fetch = real; setEnv({}); }
});

await t('application purchase uses the fee event ID and the base fee', async () => {
  setEnv({ META_PIXEL_ID: '123456789012345', META_CAPI_TOKEN: 'tok' });
  const real = globalThis.fetch; let body;
  globalThis.fetch = async (u, init) => { body = JSON.parse(init.body); return new Response('{}', { status: 200 }); };
  try {
    const app = { id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', email: 'a@b.co', first_name: 'A', last_name: 'B', program: 'Southeast Asia Gap Semester', program_type: 'semester', term: 'Spring 2027',
      answers: { mobile: { cc: '64', number: '21 555 0100' } }, payment: { base: 250, currency: 'usd', reference: 'pi_1' }, attribution: {}, ip: '1.2.3.4', user_agent: 'UA' };
    await T.trackApplication('application_fee_paid', app);
    const ev = body.data[0];
    assert.equal(ev.event_name, 'Purchase');
    assert.equal(ev.event_id, T.feeEventId(app.id));
    assert.deepEqual(ev.custom_data, { content_name: 'Southeast Asia Gap Semester', content_category: 'semester', term: 'Spring 2027', value: 250, currency: 'USD', order_id: 'pi_1' });
    assert.deepEqual(ev.user_data.ph, [sha('64215550100')]);
  } finally { globalThis.fetch = real; setEnv({}); }
});


await t('site form: booklet request → Lead with hashed data; unknown forms and bad input rejected', () => {
  const ok = T.siteFormEvent({ formId: 'a0bba9a0-aead-4667-81a9-5fa634fae057', eventId: 'form_1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    fields: { email: 'Sam@Example.com', firstname: 'Sam', phone: '+64 21 555 0100' }, page: 'https://www.pacificdiscovery.org/admissions/request-program-booklet',
    ads: { fbp: 'fb.1.1760000000000.42', fbc: 'evil<script>' }, attr: { l: { fbclid: 'IwAR0abc', ts: '2026-10-16' } } }, { ip: '203.0.113.9', userAgent: 'UA' });
  assert.equal(ok.event.event_name, 'Lead');
  assert.equal(ok.event.event_id, 'form_1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.deepEqual(ok.event.user_data.em, [sha('sam@example.com')]);
  assert.deepEqual(ok.event.user_data.ph, [sha('64215550100')]);
  assert.equal(ok.event.user_data.fbp, 'fb.1.1760000000000.42');
  assert.ok(ok.event.user_data.fbc.endsWith('.IwAR0abc'), 'bad _fbc ignored, fbclid used');
  assert.equal(ok.event.custom_data.content_name, 'Program booklet request');
  assert.equal(ok.event.event_source_url, 'https://www.pacificdiscovery.org/admissions/request-program-booklet');
  assert.equal(T.siteFormEvent({ formId: '164978ff-1220-46f4-9655-9e9ee58145b2', eventId: 'form_12345678', fields: { email: 'a@b.co' } }).error, 'unknown form');
  assert.equal(T.siteFormEvent({ formId: 'a0bba9a0-aead-4667-81a9-5fa634fae057', eventId: 'form_12345678', fields: { email: 'nope' } }).error, 'no email');
  assert.equal(T.siteFormEvent({ formId: 'a0bba9a0-aead-4667-81a9-5fa634fae057', eventId: 'x', fields: { email: 'a@b.co' } }).error, 'bad event id');
  assert.equal(T.siteFormEvent({ formId: 'a0bba9a0-aead-4667-81a9-5fa634fae057', eventId: 'form_12345678', fields: { email: 'a@b.co' }, page: 'https://evil.com/x' }).event.event_source_url, undefined);
});

await t('/api/track/form: origin check, CORS, sends CAPI', async () => {
  const track = (await import('../netlify/functions/track.mjs')).default;
  setEnv({ META_PIXEL_ID: '123456789012345', META_CAPI_TOKEN: 'tok' });
  const real = globalThis.fetch; let sentBody;
  globalThis.fetch = async (u, init) => { sentBody = JSON.parse(init.body); return new Response('{"events_received":1}', { status: 200 }); };
  try {
    const body = JSON.stringify({ formId: 'a0bba9a0-aead-4667-81a9-5fa634fae057', eventId: 'form_abcdef123', fields: { email: 'a@b.co' }, page: 'https://www.pacificdiscovery.org/x' });
    const bad = await track(new Request('http://x/api/track/form', { method: 'POST', body, headers: { origin: 'https://evil.com' } }), { ip: '1.1.1.1' });
    assert.equal(bad.status, 403);
    const res = await track(new Request('http://x/api/track/form', { method: 'POST', body, headers: { origin: 'https://www.pacificdiscovery.org', 'content-type': 'text/plain', 'user-agent': 'UA' } }), { ip: '1.1.1.2' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.pacificdiscovery.org');
    assert.equal(sentBody.data[0].event_name, 'Lead');
    assert.equal(sentBody.data[0].user_data.client_ip_address, '1.1.1.2');
  } finally { globalThis.fetch = real; setEnv({}); }
});

console.log(`tracking: ${n} passed`);
