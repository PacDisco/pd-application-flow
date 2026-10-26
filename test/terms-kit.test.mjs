// Program Terms & Conditions format + editable message helpers (pure).
import assert from 'node:assert/strict';
import * as T from '../public/terms-kit.mjs';
import { surchargeRates, withSurcharge } from '../public/form-kit.mjs';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

t('headings, numbered lists that continue, bullets, bold, links', () => {
  const h = T.termsToHtml('# Title\n\n## 3. Refunds\n\n1. First\n2. Second\nwraps here\n\n- a\n- b\n\nSee **this** and [site](https://pacificdiscovery.org).');
  assert.match(h, /<h1>Title<\/h1>/);
  assert.match(h, /<h2>3\. Refunds<\/h2>/);
  assert.match(h, /<ol><li>First<\/li><li>Second wraps here<\/li><\/ol>/);
  assert.match(h, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(h, /<strong>this<\/strong>/);
  assert.match(h, /<a href="https:\/\/pacificdiscovery.org" target="_blank" rel="noopener">site<\/a>/);
});

t('HTML and unsafe links are never rendered', () => {
  const h = T.termsToHtml('<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=1>');
  assert.ok(!/<script|<img|href="javascript/i.test(h), h);
  assert.match(h, /&lt;script&gt;/);
});

t('numbered list keeps its starting number', () => {
  assert.match(T.termsToHtml('5. five\n6. six'), /<ol start="5">/);
});

t('plain text and email HTML', () => {
  const md = '## Refunds\n\n1. **Full** refund before 90 days\n- see [terms](https://x.org)';
  assert.equal(T.termsToText(md), 'REFUNDS\n\n1. Full refund before 90 days\n\n- see terms (https://x.org)');
  assert.match(T.termsToEmailHtml(md), /<h2 style="[^"]+">Refunds<\/h2>/);
});

t('website import: main content to the editable format', () => {
  const html = '<nav>menu</nav><main><h1>Program Terms</h1><p>Intro &amp; <strong>bold</strong> <a href="https://x.org/a">link</a></p><h2><strong>1. Application</strong></h2><ul><li>One</li><li>Two</li></ul><script>x()</script></main>';
  const md = T.htmlToTerms(html);
  assert.equal(md, '# Program Terms\n\nIntro & **bold** [link](https://x.org/a)\n\n## 1. Application\n\n- One\n- Two');
  assert.match(T.termsToHtml(md), /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
});

t('templates: placeholders, defaults, unknown left visible', () => {
  assert.equal(T.fillTemplate('Hi {firstName}, {nope}', { firstName: 'Maya' }), 'Hi Maya, {nope}');
  const d = T.emailTemplate({}, 'feeConfirmation');
  assert.equal(d.enabled, true); assert.match(d.subject, /\{program\}/);
  const c = T.emailTemplate({ settings: { emails: { feeConfirmation: { enabled: false, subject: 'X', body: '' } } } }, 'feeConfirmation');
  assert.equal(c.enabled, false); assert.equal(c.subject, 'X'); assert.equal(c.body, T.DEFAULT_EMAILS.feeConfirmation.body);
  assert.match(T.feePolicyText({}, '$250'), /^Your \$250 application fee is refunded in full/);
  assert.equal(T.feePolicyText({ settings: { texts: { feePolicy: 'Fee {fee} kept.' } } }, '$250'), 'Fee $250 kept.');
});

t('surcharges: card and ACH from the dashboard, with defaults', () => {
  assert.deepEqual(surchargeRates({}), { card: 0.035, ach: 0 });
  assert.deepEqual(surchargeRates({ settings: { cardFeeRate: 0.03, achFeeRate: 0.008 } }), { card: 0.03, ach: 0.008 });
  assert.deepEqual(surchargeRates({ settings: { cardFeeRate: 0 } }), { card: 0, ach: 0 }, '0% card is allowed');
  assert.deepEqual(withSurcharge({ settings: { achFeeRate: 0.01 } }, 2250, 'ach'), { base: 2250, rate: 0.01, surcharge: 22.5, total: 2272.5, method: 'ach' });
  assert.equal(withSurcharge({}, 1750).total, 1811.25);
});

t('email buttons: a link alone on its line becomes a button (messages only)', () => {
  const md = 'Hi\n\n[Finish my application](https://x.org/?token=a)\n\nSee [terms](https://x.org/t) inline.';
  const h = T.termsToEmailHtml(md, { buttons: true });
  assert.match(h, /<table role="presentation"[^>]*>.*<a href="https:\/\/x\.org\/\?token=a"[^>]*>Finish my application<\/a>/s);
  assert.match(h, /<p [^>]*>See <a href="https:\/\/x\.org\/t"/, 'inline links stay links');
  assert.ok(!/<table/.test(T.termsToEmailHtml(md)), 'off by default (the terms)');
});

t('advisor block: Megan by default, editable, can be switched off', () => {
  assert.equal(T.advisorBlock({}).url, 'https://meetings.hubspot.com/megan-mckelvey');
  assert.equal(T.advisorBlock({ settings: { advisor: { url: 'https://meetings.hubspot.com/someone', label: 'Chat' } } }).label, 'Chat');
  assert.equal(T.advisorBlock({ settings: { advisor: { enabled: false } } }), null);
  assert.equal(T.advisorBlock({ settings: { advisor: { url: 'javascript:alert(1)' } } }), null);
});

console.log(`terms-kit: ${n} passed`);
