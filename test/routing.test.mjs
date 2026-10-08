// node test/routing.test.mjs
import assert from 'node:assert/strict';
import * as R from '../netlify/functions/_lib/routing.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const pipelines = [
  { id: '1', label: 'PD Applications', stages: [{ id: 'a1', label: 'Application Received', displayOrder: 0 }, { id: 'a2', label: 'Application Complete', displayOrder: 1 }] },
  { id: '694619955', label: 'Summer Programs', stages: [{ id: 's1', label: 'Interview Complete', displayOrder: 0 }, { id: 's2', label: 'Application Fee Received', displayOrder: 1 }] },
  { id: '74958084', label: 'Fall Semester', stages: [{ id: 'f2', label: 'Application Fee Received' }] },
  { id: '74755425', label: 'Spring Mini-Semester', stages: [{ id: 'm2', label: 'Application Fee Paid' }] },
];

t('pipeline by type + season', () => {
  assert.equal(R.targetPipelineLabel('summer', 'Summer'), 'Summer Program');
  assert.equal(R.targetPipelineLabel('semester', 'Fall'), 'Fall Semester');
  assert.equal(R.targetPipelineLabel('mini', 'Spring'), 'Spring Mini Semester');
  assert.equal(R.targetPipelineLabel('semester', 'Summer'), 'Summer Program');
  assert.equal(R.targetPipelineLabel(null, 'Winter'), null);
});

t('pipeline lookup is label-tolerant, falls back to known id', () => {
  assert.equal(R.findPipeline(pipelines, 'Summer Program').id, '694619955');
  assert.equal(R.findPipeline(pipelines, 'Spring Mini Semester').id, '74755425');
  assert.equal(R.findPipeline([], 'Spring Semester').id, '74759274');
  assert.equal(R.findApplicantPipeline(pipelines).id, '1');
});

t('stages', () => {
  assert.equal(R.findStage(R.findPipeline(pipelines, 'Summer Program'), 'appFee').id, 's2');
  assert.equal(R.findStage(R.findPipeline(pipelines, 'Spring Mini Semester'), 'appFee').id, 'm2');
  assert.equal(R.findStage(pipelines[0], 'applicationReceived').id, 'a1');
  assert.equal(R.findStage(pipelines[0], 'interviewBooked'), null);
});

const opts = [
  { value: 'New Zealand & Australia Semester', label: 'New Zealand & Australia Semester' },
  { value: 'South America Semester', label: 'South America Semester' },
  { value: 'Bali Summer Program', label: 'Bali Summer Program' },
  { value: 'New Zealand & Fiji Summer Program', label: 'New Zealand & Fiji Summer Program' },
  { value: 'Costa Rica Mini Semester', label: 'Costa Rica Mini Semester' },
  { value: 'Costa Rica Summer Program', label: 'Costa Rica Summer Program' },
  { value: 'College Credit Program', label: 'College Credit Program' },
];
t('PD Program matching', () => {
  assert.equal(R.matchPdProgram(opts, 'New Zealand and Australia Gap Semester'), 'New Zealand & Australia Semester');
  assert.equal(R.matchPdProgram(opts, 'South America Gap Semester'), 'South America Semester');
  assert.equal(R.matchPdProgram(opts, 'New Zealand and Fiji Summer Program'), 'New Zealand & Fiji Summer Program');
  assert.equal(R.matchPdProgram(opts, 'Costa Rica Mini Semester'), 'Costa Rica Mini Semester');
  assert.equal(R.matchPdProgram(opts, 'Costa Rica Summer Program'), 'Costa Rica Summer Program');
  assert.equal(R.matchPdProgram(opts, 'Japan Mini Semester'), '');
  assert.equal(R.matchPdProgram(opts, 'Anything', 'bali summer program'), 'Bali Summer Program');
});

t('payment slot + entry', () => {
  assert.equal(R.paymentEntry(250, 'pi_1', '2026-10-08T01:00:00Z'), '250, pi_1, 2026-10-08');
  assert.equal(R.choosePaymentSlot({ payment_1: '250, pi_0, 2026-01-01' }, 'pi_1'), 'payment_2');
  assert.equal(R.choosePaymentSlot({ payment_3: '250, pi_1, 2026-01-01' }, 'pi_1'), null);
});

t('app fee deal update', () => {
  const u = R.appFeeDealUpdate({
    facts: { year: '2027', price: 6550 }, pipeline: { id: 'P' }, stage: { id: 'S' }, pdProgram: 'Bali Summer Program',
    dealProps: { amount: '' }, payment: { amount: 250, reference: 'pi_9', date: '2026-10-08' },
  });
  assert.deepEqual(u, { pipeline: 'P', dealstage: 'S', pd_program: 'Bali Summer Program', travel_year: '2027', amount: '6550', payment_1: '250, pi_9, 2026-10-08' });
});
// HubSpot's real 400 body for bad properties (message embeds JSON).
const { badProperties } = await import('../netlify/functions/_lib/hubspot.mjs');
t('badProperties reads HubSpot validation errors', () => {
  const body = { status: 'error', message: 'Property values were not valid: [{"isValid":false,"message":"Property \\"bogus_prop\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"bogus_prop","localizedErrorMessage":"Property \\"bogus_prop\\" does not exist","portalId":3855728},{"isValid":false,"message":"Japan Summer was not one of the allowed options","error":"INVALID_OPTION","name":"pd_program"}]', category: 'VALIDATION_ERROR' };
  assert.deepEqual(badProperties({ body }).sort(), ['bogus_prop', 'pd_program']);
});
t('program record matching: name + season + year, ambiguity is refused', () => {
  const recs = [
    { id: '54796059552', properties: { program_name: 'South America Semester' } },
    { id: 'A', properties: { pacific_discovery_program: 'South America Semester', program_start_date: '2027-02-03' } },
    { id: 'B', properties: { pacific_discovery_program: 'South America Semester', program_start_date: '2026-09-02' } },
    { id: 'C', properties: { pacific_discovery_program: 'Costa Rica Mini Semester', program_start_date: '2027-03-01' } },
    { id: 'D', properties: { pacific_discovery_program: 'Costa Rica Summer Program', program_start_date: '2027-06-20' } },
    { id: 'E', properties: { program_name: 'Bali Summer Program 2027' } },
    { id: 'F', properties: { program_name: 'Bali Summer 2027 (B)' , program_start_date: '2027-07-01'} },
  ];
  assert.equal(R.matchProgramRecord(recs, { program: 'South America Gap Semester', programType: 'semester', season: 'Spring', year: '2027' }).record.id, 'A');
  assert.equal(R.matchProgramRecord(recs, { program: 'South America Gap Semester', programType: 'semester', season: 'Fall', year: '2026' }).record.id, 'B');
  assert.equal(R.matchProgramRecord(recs, { program: 'Costa Rica Mini Semester', programType: 'mini', season: 'Spring', year: '2027' }).record.id, 'C');
  assert.equal(R.matchProgramRecord(recs, { program: 'Costa Rica Summer Program', programType: 'summer', season: 'Summer', year: '2027' }).record.id, 'D');
  assert.equal(R.matchProgramRecord(recs, { program: 'Japan Mini Semester', programType: 'mini', season: 'Spring', year: '2027' }).record, null);
  const amb = R.matchProgramRecord(recs, { program: 'Bali Summer Program', programType: 'summer', season: 'Summer', year: '2027' });
  assert.ok(amb.record === null || amb.record.id === 'E', 'two Bali 2027 records: either refused or the exact-name one');
  assert.equal(R.seasonFromDate('2027-01-28'), 'Spring'); assert.equal(R.seasonFromDate('2027-06-15'), 'Summer'); assert.equal(R.seasonFromDate('2027-08-30'), 'Fall');
});
t('parent contacts from the answers', () => {
  const ps = R.parentContacts({ parent1Email: 'MUM@x.org', parent1Name: { first: 'A', last: 'B' }, parent1Phone: { cc: '64', number: '21 555' }, parent2Email: 'kid@x.org' }, 'kid@x.org');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].props.email, 'mum@x.org'); assert.equal(ps[0].props.phone, '+64 21 555');
});
console.log(`\n${n} passed`);
