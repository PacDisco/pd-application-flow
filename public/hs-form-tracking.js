/*
 * hs-form-tracking.js — Meta conversion tracking for HubSpot forms on
 * www.pacificdiscovery.org (loaded via GTM, all pages):
 *
 *   <script src="https://apply.pacificdiscovery.org/hs-form-tracking.js" async></script>
 *
 * When a tracked HubSpot form is submitted it
 *   1. fires the Meta pixel event (e.g. Lead) with an event ID, if the pixel is on the page;
 *   2. reports the submission to apply.pacificdiscovery.org/api/track/form, which sends the
 *      same event through the Conversions API (same event ID → Meta counts it once);
 *   3. pushes `pd_form_lead` to dataLayer for GTM / GA4.
 * Forms not listed in FORMS are ignored. The server keeps its own allowlist.
 */
(function () {
  'use strict';
  if (window.__pdHsFormTracking) return;
  window.__pdHsFormTracking = true;

  var ENDPOINT = 'https://apply.pacificdiscovery.org/api/track/form';
  var FORMS = {
    'a0bba9a0-aead-4667-81a9-5fa634fae057': { event: 'Lead', name: 'Program booklet request' },
  };
  var KEEP = ['email', 'firstname', 'lastname', 'phone', 'mobilephone'];
  var captured = {}; // formId → field values seen on onFormSubmit
  var sent = {};

  function cookie(n) {
    try { var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }
  function attr() { try { return JSON.parse(cookie('pd_attr') || 'null') || {}; } catch (e) { return {}; } }
  function newId() {
    try { return 'form_' + crypto.randomUUID(); } catch (e) { return 'form_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
  }
  // HubSpot sends values as [{name, value}] (onFormSubmit) or { submissionValues: {...} } (onFormSubmitted).
  function values(data) {
    var out = {};
    if (Array.isArray(data)) {
      data.forEach(function (f) { if (f && KEEP.indexOf(f.name) >= 0) out[f.name] = String(f.value || ''); });
    } else if (data && typeof data === 'object') {
      var sv = data.submissionValues || data.fields || data;
      KEEP.forEach(function (k) { if (sv[k] != null && typeof sv[k] !== 'object') out[k] = String(sv[k]); });
    }
    return out;
  }

  function report(formId, fields) {
    var form = FORMS[formId];
    if (!form || sent[formId]) return;
    sent[formId] = true;
    var eventId = newId();
    try { if (window.fbq) window.fbq('track', form.event, { content_name: form.name }, { eventID: eventId }); } catch (e) { /* ignore */ }
    try { (window.dataLayer = window.dataLayer || []).push({ event: 'pd_form_lead', pd_form: form.name, pd_event_id: eventId }); } catch (e) { /* ignore */ }
    var a = attr();
    var body = JSON.stringify({
      formId: formId, eventId: eventId, fields: fields, page: location.href.split('#')[0],
      ads: { fbp: cookie('_fbp'), fbc: cookie('_fbc') }, attr: { f: a.f, l: a.l },
    });
    try {
      // text/plain + sendBeacon: no CORS preflight, and it survives HubSpot's thank-you redirect
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) { /* fall through */ }
    try { fetch(ENDPOINT, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, mode: 'no-cors' }); } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'hsFormCallback' || !FORMS[d.id]) return;
    if (d.eventName === 'onFormSubmit') {
      captured[d.id] = values(d.data);
    } else if (d.eventName === 'onFormSubmitted') {
      var v = values(d.data);
      var merged = captured[d.id] || {};
      for (var k in v) if (v[k]) merged[k] = v[k];
      report(d.id, merged);
    }
  });
})();
