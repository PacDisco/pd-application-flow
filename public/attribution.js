/*
 * attribution.js — first-party source tracking for Pacific Discovery.
 *
 * Remembers where a visitor first came from (first touch) and the latest
 * campaign/referral that brought them back (last touch) in one cookie,
 * `pd_attr`, scoped to .pacificdiscovery.org so www.pacificdiscovery.org and
 * apply.pacificdiscovery.org share it. The quiz and the application send it
 * with the submission, so HubSpot gets the real source even when HubSpot's
 * own Original Source says "Offline".
 *
 * Put it on every page of the main website too (WordPress footer):
 *   <script src="https://apply.pacificdiscovery.org/attribution.js" async></script>
 *
 * Read it with window.PDAttribution.get() → { f: {…first}, l: {…last} }.
 * No personal data is stored — only campaign parameters, landing page and the
 * referring site.
 */
(function () {
  'use strict';
  var NAME = 'pd_attr';
  var MAX_AGE = 365 * 24 * 3600;
  var PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid', 'li_fat_id'];
  var ROOT = /(^|\.)pacificdiscovery\.org$/i;

  function domainAttr() {
    return ROOT.test(location.hostname) ? '; domain=.pacificdiscovery.org' : '';
  }
  function read() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)pd_attr=([^;]*)/);
      return m ? JSON.parse(decodeURIComponent(m[1])) : null;
    } catch (e) { return null; }
  }
  function write(v) {
    try {
      document.cookie = NAME + '=' + encodeURIComponent(JSON.stringify(v)) + '; path=/; max-age=' + MAX_AGE +
        '; SameSite=Lax' + domainAttr() + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) { /* cookies blocked */ }
  }
  function cut(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
  function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }

  function touchFromHere() {
    var url;
    try { url = new URL(location.href); } catch (e) { return null; }
    // Embedded on the main site, the parent passes its own URL as ?page=
    var page = url.searchParams.get('page');
    var t = { ts: new Date().toISOString().slice(0, 10) };
    var hasParam = false;
    PARAMS.forEach(function (k) {
      var v = url.searchParams.get(k);
      if (v) { t[k] = cut(v, 150); hasParam = true; }
    });
    var keep = new URLSearchParams();
    PARAMS.slice(0, 5).forEach(function (k) { if (t[k]) keep.set(k, t[k]); });
    t.landing = cut(page || (url.origin + url.pathname + (keep.toString() ? '?' + keep.toString() : '')), 250);
    var ref = document.referrer || '';
    var rh = hostOf(ref);
    var internal = !rh || ROOT.test(rh) || rh === location.hostname || /(^|\.)stripe\.com$|(^|\.)hubspot\.com$/.test(rh);
    if (!internal) t.referrer = cut(ref.split('?')[0], 200);
    t._new = hasParam || !internal;
    return t;
  }

  function run() {
    var t = touchFromHere();
    if (!t) return;
    var isNew = t._new; delete t._new;
    var s = read() || {};
    if (!s.f) s.f = t;              // first touch, kept for a year
    if (isNew || !s.l) s.l = t;     // latest campaign / referral visit
    write(s);
  }

  try { run(); } catch (e) { /* never break the page */ }
  window.PDAttribution = { get: read, refresh: function () { try { run(); } catch (e) { /* ignore */ } return read(); } };
})();
