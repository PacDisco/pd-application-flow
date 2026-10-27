// Application-fee reminders: schedule logic (pure) + the hourly run against a
// real Postgres (TEST_PG_URL, MIGRATION-apply.sql + MIGRATION-reminders.sql).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDb } from './harness.mjs';

Object.assign(process.env, {
  SMTP_USER: 'apply@pacificdiscovery.org', SMTP_PASS: 'x', APPLY_SITE_URL: 'https://apply.example.org',
  HUBSPOT_TOKEN: '', HUBSPOT_API_KEY: '', HUBSPOT_PRIVATE_APP_TOKEN: '',
});

const DAY = 864e5;
const now = new Date('2026-11-20T12:00:00Z');
const ago = (d) => new Date(now.getTime() - d * DAY).toISOString();
const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
schema.settings.feeReminders = { enabled: true, since: ago(60) };
const { pool } = await setupDb(schema);
const R = await import('../netlify/functions/_lib/reminders.mjs');
const A = await import('../netlify/functions/_lib/applications.mjs');
const N = await import('../netlify/functions/_lib/notify.mjs');
const mails = [];
N.__setTransport({ sendMail: async (m) => { mails.push(m); return {}; } });
const apply = (await import('../netlify/functions/apply.mjs')).default;

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const base = { step2_at: ago(2), paid_at: null, status: 'step2', reminders: {}, interview_at: null, interview: null };

await t('schedule: off unless switched on, with a start date', async () => {
  assert.equal(R.reminderAction(base, {}, now).reason, 'off');
  assert.equal(R.reminderAction(base, { settings: { feeReminders: { enabled: true } } }, now).reason, 'off');
});

await t('schedule: day 1, 4, 10, 21; close at 28', async () => {
  const at = (d, sent = {}) => R.reminderAction({ ...base, step2_at: ago(d), reminders: { sent } }, schema, now);
  assert.equal(at(0.5).reason, 'not yet');
  assert.deepEqual(at(1.1), { action: 'send', stage: 1, skip: [] });
  assert.equal(at(3, { 1: { at: ago(2) } }).reason, 'up to date');
  assert.deepEqual(at(4.2, { 1: { at: ago(3) } }), { action: 'send', stage: 2, skip: [] });
  assert.deepEqual(at(10.5, { 1: { at: ago(9) }, 2: { at: ago(6) } }), { action: 'send', stage: 3, skip: [] });
  assert.deepEqual(at(22, { 1: { at: ago(21) }, 2: { at: ago(18) }, 3: { at: ago(12) } }), { action: 'send', stage: 4, skip: [] });
  assert.deepEqual(at(28.1), { action: 'close' });
});

await t('accepted before paying: no more fee reminders (the fee is part of the deposit now)', async () => {
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.2), decision: { outcome: 'accepted' } }, schema, now).reason, 'accepted');
});

await t('schedule: a missed stretch sends only the latest reminder, never a burst', async () => {
  const a = R.reminderAction({ ...base, step2_at: ago(11) }, schema, now);
  assert.deepEqual(a, { action: 'send', stage: 3, skip: [1, 2] });
  const b = R.reminderAction({ ...base, step2_at: ago(11), reminders: { sent: { 3: { at: ago(0.5) } }, skipped: [1, 2] } }, schema, now);
  assert.equal(b.reason, 'sent recently');
});

await t('schedule: paid, withdrawn, stopped, closed, or finished before switch-on → nothing', async () => {
  const s2 = { ...schema, settings: { ...schema.settings, feeReminders: { enabled: true, since: ago(5) } } };
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.5), paid_at: ago(1) }, schema, now).reason, 'paid');
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.5), status: 'withdrawn' }, schema, now).reason, 'withdrawn');
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.5), decision: { outcome: 'declined' } }, schema, now).reason, 'declined');
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.5), reminders: { stopped: { at: ago(1) } } }, schema, now).reason, 'stopped');
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.5), reminders: { closedAt: ago(1) } }, schema, now).reason, 'closed');
  assert.equal(R.reminderAction({ ...base, step2_at: ago(6) }, s2, now).reason, 'before reminders were switched on');
});

await t('schedule: a reminder switched off in the dashboard is skipped, not sent', async () => {
  const s3 = structuredClone(schema); s3.settings.emails = { feeReminder2: { enabled: false } };
  assert.deepEqual(R.reminderAction({ ...base, step2_at: ago(4.5), reminders: { sent: { 1: { at: ago(3) } } } }, s3, now), { action: 'skip', stage: 2, skip: [] });
});

await t('fee confirmation: "Book your interview" is the main button until they have booked', async () => {
  const app = { ...base, first_name: 'Maya', last_name: 'Ortiz', email: 'maya@example.com', program: 'South America Gap Semester', term: 'Spring 2027', answers: {}, paid_at: ago(0.1), payment: { base: 250, total: 258.75, currency: 'usd', reference: 'pi_1' } };
  const c = N.feeConfirmationContent(app, { settings: { appFee: 250 } }, null);
  assert.match(c.html, /<a href="https:\/\/meetings\.hubspot\.com\/eda-admissions\/pacific-discovery-interviews\?firstName=Maya&amp;lastName=Ortiz&amp;email=maya%40example\.com"[^>]*>Book your interview<\/a>/);
  assert.ok(c.html.indexOf('Book your interview</a>') < c.html.indexOf('What happens next'), 'it comes first');
  assert.match(c.text, /Next step: book your interview/);
  const booked = N.feeConfirmationContent({ ...app, interview_at: ago(1), interview: { label: 'Tue 3 Nov, 9:00 AM' } }, { settings: {} }, null);
  assert.ok(!/Book your interview<\/a>/.test(booked.html));
  assert.match(booked.text, /Your interview is booked for Tue 3 Nov, 9:00 AM\./);
  assert.ok(!/\{\w+\}/.test(c.text + booked.text), 'no unfilled placeholders');
});

await t('content: next step depends on the interview; link and close date filled', async () => {
  const app = { ...base, first_name: 'Maya', program: 'South America Gap Semester', term: 'Spring 2027', answers: { preferredName: 'Maya' } };
  const c1 = N.feeReminderContent(app, schema, 1, { link: 'https://apply.example.org/?token=abc' });
  assert.match(c1.text, /book your interview and pay the \$250 application fee/);
  assert.match(c1.html, /<a href="https:\/\/apply\.example\.org\/\?token=abc"[^>]*>Finish my application<\/a>/);
  assert.match(c1.html, /border-radius:8px;background:#288195/, 'the link is a button');
  assert.match(c1.html, /href="https:\/\/meetings\.hubspot\.com\/megan-mckelvey"[^>]*>Book a call with an advisor</);
  assert.match(c1.text, /Book a call with an advisor: https:\/\/meetings\.hubspot\.com\/megan-mckelvey/);
  const c4 = N.feeReminderContent({ ...app, interview_at: ago(3) }, schema, 4, { link: 'https://x.org/', closeDate: '2026-12-10T00:00:00Z' });
  assert.match(c4.text, /close your application on December 10/);
  assert.equal(c4.subject, 'Should we keep your application open?');
  for (const s of [1, 2, 3, 4]) assert.ok(!/\{\w+\}/.test(N.feeReminderContent(app, schema, s, { link: 'https://x.org/', closeDate: now }).text), `stage ${s} placeholders`);
});

// ── the hourly run, against the database ────────────────────────────────────
async function insertApp(email, step2DaysAgo, extra = {}) {
  const answers = { preferredName: email.split('@')[0], parent1Email: `parent.${email}`, parent1Name: { first: 'P', last: 'Q' } };
  const [r] = (await pool.query(
    `INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, paid_at, reminders)
     VALUES ($1,$2,'Test','Person','South America Gap Semester','Spring 2027',$3,$4,$5,$5,$6,$7) RETURNING id`,
    [`h-${email}`, email, extra.status || 'step2', JSON.stringify(answers), ago(step2DaysAgo), extra.paid ? ago(1) : null, JSON.stringify(extra.reminders || {})])).rows;
  return r.id;
}
const rem = async (id) => (await pool.query('SELECT reminders, link_token_hashes FROM applications WHERE id = $1', [id])).rows[0];

let a1, a11, a29, aPaid, aStop;
await t('run: sends due reminders to student + parents, skips the rest', async () => {
  a1 = await insertApp('day1@x.org', 1.2);
  a11 = await insertApp('day11@x.org', 11);
  a29 = await insertApp('day29@x.org', 29);
  aPaid = await insertApp('paid@x.org', 5, { paid: true, status: 'paid' });
  aStop = await insertApp('stop@x.org', 5, { reminders: { stopped: { at: ago(1), by: 'Ed' } } });
  await insertApp('young@x.org', 0.3);
  const out = await R.runReminders({ schema, now, log: { error() {} } });
  assert.equal(out.sent, 2); assert.equal(out.closed, 1);
  assert.equal(mails.length, 2);
  const m1 = mails.find((m) => m.to.includes('day1@x.org'));
  assert.equal(m1.to, 'day1@x.org, parent.day1@x.org');
  assert.equal(m1.subject, 'Your Pacific Discovery application is almost done');
  assert.match(m1.from, /admissions@pacificdiscovery\.org/);
  const m11 = mails.find((m) => m.to.includes('day11@x.org'));
  assert.equal(m11.subject, 'Checking in about your application');
  const r11 = await rem(a11);
  assert.deepEqual(r11.reminders.skipped, [1, 2]);
  assert.equal(r11.reminders.sent['3'].to.length, 2);
  assert.ok(!r11.reminders.sent['3'].pending);
  assert.ok((await rem(a29)).reminders.closedAt);
  assert.deepEqual((await rem(aPaid)).reminders, {});
});

await t('run again: nothing new (no duplicates)', async () => {
  const out = await R.runReminders({ schema, now, log: { error() {} } });
  assert.equal(out.sent, 0); assert.equal(mails.length, 2);
});

await t('the emailed link opens the application (and the original token still works)', async () => {
  const link = mails.find((m) => m.to.includes('day1@x.org')).text.match(/token=([A-Za-z0-9_-]+)/)[1];
  const r = await apply(new Request(`https://apply.example.org/api/apply/status?token=${link}`));
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.email, 'day1@x.org');
  assert.equal((await rem(a1)).link_token_hashes.length, 1);
  assert.equal(await A.byToken('not-a-real-token-but-long-enough'), null);
});

await t('a closed application still opens from its link and can go on to pay', async () => {
  assert.ok((await rem(a29)).reminders.closedAt);
  const tok = await A.addLinkToken(a29);
  for (let i = 0; i < 15; i++) await A.addLinkToken(a29); // many emails later…
  const r = await apply(new Request(`https://apply.example.org/api/apply/status?token=${tok}`));
  const body = await r.json();
  assert.equal(r.status, 200, 'the first link still works after many more');
  assert.ok(['interview', 'payment'].includes(body.step), body.step);
  assert.equal(body.paid, false);
});

await t('a failed send is released and retried on the next run', async () => {
  const id = await insertApp('fail@x.org', 4.5, { reminders: { sent: { 1: { at: ago(3) } } } });
  N.__setTransport({ sendMail: async () => { throw new Error('SMTP down'); } });
  const out = await R.runReminders({ schema, now, log: { error() {} } });
  assert.equal(out.failed, 1);
  const r = await rem(id);
  assert.equal(r.reminders.sent['2'], undefined);
  assert.match(r.reminders.lastError.error, /SMTP down/);
  N.__setTransport({ sendMail: async (m) => { mails.push(m); return {}; } });
  const again = await R.runReminders({ schema, now, log: { error() {} } });
  assert.equal(again.sent, 1);
  assert.ok((await rem(id)).reminders.sent['2'].at);
  assert.equal((await rem(id)).reminders.lastError, undefined);
});

await t('each reminder is logged on HubSpot — with the personal login link removed', async () => {
  const { fakeUpstreams } = await import('./harness.mjs');
  const up = fakeUpstreams();
  process.env.HUBSPOT_TOKEN = 'x';
  try {
    const id = await insertApp('hs@x.org', 1.3);
    await pool.query(`UPDATE applications SET hubspot_contact_id = 'C9', hubspot_deal_id = 'D9' WHERE id = $1`, [id]);
    const out = await R.runReminders({ schema, now, log: { error() {} } });
    assert.equal(out.sent, 1);
    const e = up.crm.emails.at(-1);
    assert.equal(e.properties.hs_email_subject, 'Your Pacific Discovery application is almost done');
    assert.ok(!/token=/.test(e.properties.hs_email_html + e.properties.hs_email_text), 'no login token in HubSpot');
    assert.match(e.properties.hs_email_html, /href="https:\/\/apply\.example\.org\/"/);
    assert.deepEqual(e.associations.map((a) => [a.to.id, a.types[0].associationTypeId]), [['C9', 198], ['D9', 210]]);
    assert.ok(mails.at(-1).text.includes('token='), 'the family still gets their personal link');
    assert.equal((await rem(id)).reminders.sent['1'].hubspot.id, 'e1');
  } finally { delete process.env.HUBSPOT_TOKEN; up.restore(); }
});

await t('fee paid another way (on the HubSpot deal): no reminder, reminders stopped', async () => {
  const { fakeUpstreams } = await import('./harness.mjs');
  const up = fakeUpstreams();
  process.env.HUBSPOT_TOKEN = 'x';
  try {
    const id = await insertApp('portalfee@x.org', 1.3);
    up.crm.deals.set('777', { id: '777', properties: { pipeline: '1', dealstage: 'a1', payment_1: '250, pi_portal, 2026-10-20' } });
    await pool.query(`UPDATE applications SET hubspot_contact_id = 'C7', hubspot_deal_id = '777' WHERE id = $1`, [id]);
    const before = mails.length;
    const out = await R.runReminders({ schema, now, log: { error() {} } });
    assert.equal(out.paidOnDeal, 1);
    assert.equal(mails.filter((m, i) => i >= before && m.to.includes('portalfee')).length, 0);
    assert.equal((await rem(id)).reminders.stopped.by, 'paid on the HubSpot deal');
  } finally { delete process.env.HUBSPOT_TOKEN; up.restore(); }
});

await t('interview check: picks the right HubSpot meeting', async () => {
  const IC = await import('../netlify/functions/_lib/interview-check.mjs');
  const app = { step1_at: ago(5) };
  const mk = (id, title, startDays, extra = {}) => ({ id, title, start: new Date(now.getTime() + startDays * DAY).toISOString(), createdAt: ago(2), outcome: 'SCHEDULED', ...extra });
  assert.equal(IC.pickInterview([mk('1', 'Team sync', 2)], app, schema, now), null, 'title must match');
  assert.equal(IC.pickInterview([mk('1', 'Pacific Discovery Interview', 2, { outcome: 'CANCELED' })], app, schema, now), null, 'cancelled');
  assert.equal(IC.pickInterview([mk('1', 'Pacific Discovery Interview', 2, { createdAt: ago(40) })], app, schema, now), null, 'from before this application');
  assert.equal(IC.pickInterview([mk('1', 'Interview', -1), mk('2', 'Interview', 3), mk('3', 'Interview', 1)], app, schema, now).id, '3', 'earliest upcoming');
  assert.equal(IC.pickInterview([mk('1', 'Interview', -3), mk('2', 'Interview', -1)], app, schema, now).id, '2', 'else latest past');
  assert.equal(IC.pickInterview([mk('1', 'Admissions chat', 2)], app, { settings: { interviewMatch: 'admissions chat' } }, now).id, '1', 'match is a dashboard setting');
  assert.match(IC.interviewLabel('2026-11-03T16:00:00Z'), /^Tuesday, November 3, 2026 at 9:00 AM MST$/);
});

await t('interview booked from an email → found in HubSpot before the next reminder', async () => {
  const { fakeUpstreams } = await import('./harness.mjs');
  const up = fakeUpstreams();
  process.env.HUBSPOT_TOKEN = 'x';
  try {
    const id = await insertApp('booked@x.org', 4.3, { reminders: { sent: { 1: { at: ago(3) } } } });
    await pool.query(`UPDATE applications SET hubspot_contact_id = '777' WHERE id = $1`, [id]);
    up.crm.meetings.set('m1', { id: 'm1', properties: { hs_meeting_title: 'Pacific Discovery Interview', hs_meeting_start_time: new Date(now.getTime() + 2 * DAY).toISOString(), hs_meeting_outcome: 'SCHEDULED', hs_createdate: ago(1) } });
    up.crm.meetingAssoc.set('777', ['m1']);
    const out = await R.runReminders({ schema, now, log: { error() {}, warn() {} } });
    assert.equal(out.sent, 1); assert.equal(out.interviewsFound, 1);
    const mail = mails.at(-1);
    assert.match(mail.text, /pay the \$250 application fee so we can review your application/);
    assert.ok(!/book your interview/i.test(mail.text));
    const [row] = (await pool.query('SELECT interview_at, interview, status FROM applications WHERE id = $1', [id])).rows;
    assert.ok(row.interview_at); assert.equal(row.interview.source, 'hubspot'); assert.equal(row.interview.meetingId, 'm1');
    assert.equal(row.status, 'interview');
  } finally { delete process.env.HUBSPOT_TOKEN; up.restore(); }
});

await t('switched off → the run does nothing', async () => {
  const off = structuredClone(schema); off.settings.feeReminders.enabled = false;
  await insertApp('off@x.org', 1.5);
  const out = await R.runReminders({ schema: off, now });
  assert.equal(out.off, true); assert.equal(out.sent, 0);
});

await pool.end();
console.log(`reminders: ${n} passed`);
