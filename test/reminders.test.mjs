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
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.5), reminders: { stopped: { at: ago(1) } } }, schema, now).reason, 'stopped');
  assert.equal(R.reminderAction({ ...base, step2_at: ago(4.5), reminders: { closedAt: ago(1) } }, schema, now).reason, 'closed');
  assert.equal(R.reminderAction({ ...base, step2_at: ago(6) }, s2, now).reason, 'before reminders were switched on');
});

await t('schedule: a reminder switched off in the dashboard is skipped, not sent', async () => {
  const s3 = structuredClone(schema); s3.settings.emails = { feeReminder2: { enabled: false } };
  assert.deepEqual(R.reminderAction({ ...base, step2_at: ago(4.5), reminders: { sent: { 1: { at: ago(3) } } } }, s3, now), { action: 'skip', stage: 2, skip: [] });
});

await t('content: next step depends on the interview; link and close date filled', async () => {
  const app = { ...base, first_name: 'Maya', program: 'South America Gap Semester', term: 'Spring 2027', answers: { preferredName: 'Maya' } };
  const c1 = N.feeReminderContent(app, schema, 1, { link: 'https://apply.example.org/?token=abc' });
  assert.match(c1.text, /book your interview and pay the \$250 application fee/);
  assert.match(c1.html, /href="https:\/\/apply\.example\.org\/\?token=abc"/);
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

await t('switched off → the run does nothing', async () => {
  const off = structuredClone(schema); off.settings.feeReminders.enabled = false;
  await insertApp('off@x.org', 1.5);
  const out = await R.runReminders({ schema: off, now });
  assert.equal(out.off, true); assert.equal(out.sent, 0);
});

await pool.end();
console.log(`reminders: ${n} passed`);
