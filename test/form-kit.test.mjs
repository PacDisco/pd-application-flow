// node test/form-kit.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as K from '../public/form-kit.mjs';

const schema = JSON.parse(readFileSync(new URL('../scripts/seed-schema.json', import.meta.url)));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const step1 = {
  name: { first: 'Ava', last: 'Lee' }, preferredName: 'Ava', dob: '2007-04-09', email: 'AVA@Example.com ',
  mobile: { cc: '1', number: '303 555 0100' }, gender: 'Female', program: 'Bali Summer Program', term: 'Summer 2027',
  utm_source: 'google',
};

t('lint: seed schema has no errors', () => {
  const errs = K.lintSchema(schema).filter((x) => x.level === 'error');
  assert.deepEqual(errs, []);
});

t('terms follow the program type', () => {
  assert.deepEqual(K.termsFor(schema, 'Bali Summer Program').map((x) => x.season), K.termsFor(schema, 'Bali Summer Program').map(() => 'Summer'));
  assert.ok(K.termsFor(schema, 'Japan Mini Semester').every((x) => x.season !== 'Summer'));
});

t('step 1 validates and normalises', () => {
  const r = K.validateStep(schema, 'step1', step1);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.clean.email, 'ava@example.com');
  assert.equal(r.clean.utm_source, 'google');
});

t('step 1 rejects a summer term on a semester program', () => {
  const r = K.validateStep(schema, 'step1', { ...step1, program: 'South America Gap Semester' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.term);
});

t('required + conditional fields on step 2', () => {
  const r = K.validateStep(schema, 'step2', { hasPassport: 'Yes' });
  assert.ok(r.errors.passportCountry && r.errors.passportExpiry);
  assert.ok(!r.errors.noPassportReason);
  const r2 = K.validateStep(schema, 'step2', { hasPassport: 'No', respiratory: 'No' });
  assert.ok(!r2.errors.passportCountry && !r2.errors.respiratoryDetails);
  const r3 = K.validateStep(schema, 'step2', { respiratory: 'Yes' });
  assert.ok(r3.errors.respiratoryDetails);
});

t('hidden fields never validate or show', () => {
  const f = K.fieldByKey(schema, 'passportNumber');
  assert.equal(K.isVisible(schema, f, { hasPassport: 'Yes' }), false);
});

t('derived: deal amount + text copies', () => {
  const v = K.computeDerived(schema, K.validateStep(schema, 'step1', step1).clean);
  assert.equal(v.dealAmount, '6550');
  assert.equal(v.dobText, '04-09-2007');
  assert.equal(v.mobileText, '+1 303 555 0100');
});

t('jotform answers: summer term goes to qid 132 on step 1, 120 on step 2', () => {
  const v = K.computeDerived(schema, K.validateStep(schema, 'step1', step1).clean);
  const a1 = K.toJotformAnswers(schema, 'step1', v);
  assert.equal(a1['132'].answer, 'Summer 2027');
  assert.equal(a1['120'], undefined);
  const a2 = K.toJotformAnswers(schema, 'step2', v);
  assert.equal(a2['120'].answer, 'Summer 2027');
  assert.equal(a2['16'].type, 'control_email');
  assert.equal(a2['16'].answer, 'ava@example.com');
  assert.deepEqual(a2['6'].answer.year, '2007');
  assert.equal(a2['4'].name, 'name');
  assert.equal(a2['135'].answer, '+1 303 555 0100');
  assert.equal(a2['128'], undefined, 'utm only on step 1');
});

t('jotform params', () => {
  const v = K.computeDerived(schema, K.validateStep(schema, 'step1', step1).clean);
  const p = K.toJotformParams(schema, 'step2', { ...v, homeAddress: { addr_line1: '1 Main', city: 'Boulder' }, photo: [{ id: 'x', name: 'me.jpg', url: 'https://a/x' }] });
  assert.equal(p['submission[4][first]'], 'Ava');
  assert.equal(p['submission[6][year]'], '2007');
  assert.equal(p['submission[13][city]'], 'Boulder');
  assert.equal(p['submission[92]'], 'https://a/x');
  assert.equal(p['submission[127]'], '6550');
});

t('fee: $250 + 3.5% = $258.75', () => {
  assert.deepEqual(K.feeBreakdown(schema), { base: 250, rate: 0.035, surcharge: 8.75, total: 258.75 });
});

t('enrolment facts', () => {
  assert.deepEqual(K.enrolmentFacts(schema, { program: 'Japan Mini Semester', term: 'Spring 2027' }),
    { program: 'Japan Mini Semester', programType: 'mini', pdProgram: '', price: 10500, season: 'Spring', year: '2027' });
});

console.log(`\n${n} passed`);

// student vs parent contact details must be unique
{
  const base = { email: 'kid@x.org', mobile: { cc: '1', number: '303 555 0100' }, hasPassport: 'No' };
  const e1 = K.validateStep(schema, 'step2', { ...base, parent1Email: 'KID@x.org ', parent1Phone: { cc: '1', number: '(303) 555-0100' } }).errors;
  assert.match(e1.parent1Email, /different from the student's email/);
  assert.match(e1.parent1Phone, /different from the student's phone/);
  const e2 = K.validateStep(schema, 'step2', { ...base, parent1Email: 'mum@x.org', parent2Email: 'mum@x.org', parent1Phone: { cc: '1', number: '720 555 0101' }, parent2Phone: { cc: '44', number: '0720 555 0101' } }).errors;
  assert.ok(!e2.parent1Email && !e2.parent1Phone);
  assert.match(e2.parent2Email, /primary parent\/guardian's email/);
  assert.match(e2.parent2Phone, /primary parent\/guardian's phone/);
  const e3 = K.validateStep(schema, 'step2', { ...base, parent1Email: 'mum@x.org', parent1Phone: { cc: '1', number: '720 555 0101' } }).errors;
  assert.ok(!e3.parent1Email && !e3.parent1Phone && !e3.parent2Email);
  console.log('  ✓ student and parent emails / phones must be unique');
}
