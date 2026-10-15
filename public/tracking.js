/*
 * tracking.js — ad & analytics tags for the quiz and the application.
 *
 * Reads the tag IDs from window.PD_TRACKING (set by /tracking-config.js, from
 * Netlify env vars) and loads only what's configured: Meta pixel, Google tag
 * (GA4 + Google Ads), TikTok pixel and/or Google Tag Manager. Nothing loads in
 * preview mode (?preview=1) or when TRACKING=off.
 *
 *   PDTrack.event(name, data, { eventId })   one funnel event → every platform
 *   PDTrack.newId(prefix)                     event ID shared with the server
 *   PDTrack.cookies()                         { fbp, fbc, ttp } for server events
 *   PDTrack.once(key)                         true the first time per browser
 *
 * Funnel events: quiz_start, quiz_lead, application_start, application_submit,
 * interview_booked, application_fee_paid. Each is also pushed to dataLayer as
 * `pd_<name>` and, when embedded, posted to the parent page as { pdTrack }.
 */
(function () {
  'use strict';
  var C = window.PD_TRACKING || {};
  var url = null;
  try { url = new URL(location.href); } catch (e) { /* ignore */ }
  var preview = !!(url && url.searchParams.get('preview') === '1');
  var embedded = window.parent !== window;
  var on = !C.off && !preview;
  var dl = window.dataLayer = window.dataLayer || [];

  function load(src) {
    var s = document.createElement('script');
    s.async = true; s.src = src;
    (document.head || document.documentElement).appendChild(s);
  }

  // Meta standard events (quiz_start is a custom event).
  var META = {
    quiz_start: { n: 'QuizStart', custom: true },
    quiz_lead: { n: 'Lead' },
    application_start: { n: 'CompleteRegistration' },
    application_submit: { n: 'SubmitApplication' },
    interview_booked: { n: 'Schedule' },
    application_fee_paid: { n: 'Purchase' },
  };
  var GA = { quiz_lead: 'generate_lead', application_fee_paid: 'purchase' };
  var TIKTOK = { quiz_lead: 'SubmitForm', application_start: 'CompleteRegistration', application_submit: 'SubmitApplication', interview_booked: 'Schedule', application_fee_paid: 'CompletePayment' };

  if (on) {
    try {
      if (C.gtm) {
        dl.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
        load('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(C.gtm));
      }
      if (C.ga4 || C.ads) {
        window.gtag = window.gtag || function () { dl.push(arguments); };
        window.gtag('js', new Date());
        if (C.ga4) window.gtag('config', C.ga4);
        if (C.ads) window.gtag('config', C.ads);
        load('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(C.ga4 || C.ads));
      }
      if (C.meta && !window.fbq) {
        var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
        if (!window._fbq) window._fbq = n;
        n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
        load('https://connect.facebook.net/en_US/fbevents.js');
        window.fbq('init', C.meta);
        // When embedded, the host page's own pixel already counts the page view.
        if (!embedded) window.fbq('track', 'PageView');
      }
      if (C.tiktok && !window.ttq) {
        (function (w, d, t) {
          w.TiktokAnalyticsObject = t;
          var ttq = w[t] = w[t] || [];
          ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
          ttq.setAndDefer = function (o, e) { o[e] = function () { o.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
          for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
          ttq.instance = function (id) { for (var e = ttq._i[id] || [], k = 0; k < ttq.methods.length; k++) ttq.setAndDefer(e, ttq.methods[k]); return e; };
          ttq.load = function (id, opts) {
            var r = 'https://analytics.tiktok.com/i18n/pixel/events.js';
            ttq._i = ttq._i || {}; ttq._i[id] = []; ttq._i[id]._u = r;
            ttq._t = ttq._t || {}; ttq._t[id] = +new Date();
            ttq._o = ttq._o || {}; ttq._o[id] = opts || {};
            load(r + '?sdkid=' + encodeURIComponent(id) + '&lib=' + t);
          };
          ttq.load(C.tiktok);
          ttq.page();
        })(window, document, 'ttq');
      }
    } catch (e) { /* never break the page */ }
  }

  function clean(o) {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k];
    return out;
  }

  function event(name, data, opts) {
    data = data || {}; opts = opts || {};
    var id = opts.eventId || undefined;
    try { dl.push(clean(Object.assign({ event: 'pd_' + name, pd_event_id: id }, data))); } catch (e) { /* ignore */ }
    if (embedded) { try { window.parent.postMessage({ pdTrack: { event: name, eventId: id, data: data } }, '*'); } catch (e) { /* ignore */ } }
    if (!on) return;
    var value = data.value, currency = data.currency;
    try {
      var m = META[name];
      if (C.meta && window.fbq && m) {
        var mp = clean({ content_name: data.program || data.content_name, content_category: data.program_type, value: value, currency: currency, archetype: data.archetype, travel_when: data.travel_when, term: data.term });
        window.fbq(m.custom ? 'trackCustom' : 'track', m.n, mp, id ? { eventID: id } : undefined);
      }
    } catch (e) { /* ignore */ }
    try {
      if (window.gtag && C.ga4) {
        var gp = clean(Object.assign({}, data, { send_to: C.ga4, transaction_id: name === 'application_fee_paid' ? id : undefined }));
        window.gtag('event', GA[name] || name, gp);
      }
      if (window.gtag && C.ads && C.adsLabels && C.adsLabels[name]) {
        window.gtag('event', 'conversion', clean({ send_to: C.ads + '/' + C.adsLabels[name], value: value, currency: currency, transaction_id: id }));
      }
    } catch (e) { /* ignore */ }
    try {
      if (C.tiktok && window.ttq && TIKTOK[name]) {
        window.ttq.track(TIKTOK[name], clean({ content_name: data.program || data.content_name, value: value, currency: currency }), id ? { event_id: id } : undefined);
      }
    } catch (e) { /* ignore */ }
  }

  function cookie(name) {
    try { var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }

  function newId(prefix) {
    var r;
    try { r = crypto.randomUUID(); } catch (e) { r = Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
    return (prefix ? prefix + '_' : '') + r;
  }

  function once(key) {
    try {
      var k = 'pd-tracked:' + key;
      if (localStorage.getItem(k)) return false;
      localStorage.setItem(k, '1');
      return true;
    } catch (e) { return true; }
  }

  window.PDTrack = {
    on: on,
    event: event,
    newId: newId,
    once: once,
    cookies: function () { return clean({ fbp: cookie('_fbp'), fbc: cookie('_fbc'), ttp: cookie('_ttp') }); },
  };
})();
