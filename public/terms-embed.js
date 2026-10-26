/*
 * Program Terms & Conditions embed for www.pacificdiscovery.org.
 *
 * Paste on the terms page (HTML / custom module):
 *
 *   <div id="pd-terms"></div>
 *   <script src="https://apply.pacificdiscovery.org/terms-embed.js" defer></script>
 *
 * The text comes from the dashboard (Apply Form → Terms). Publishing there
 * updates this page within a minute. Styling is minimal and inherits the
 * page's fonts; add `data-no-style` to the div to skip it entirely.
 */
(function () {
  var el = document.getElementById('pd-terms');
  if (!el) return;
  var src = (document.currentScript && document.currentScript.src) || 'https://apply.pacificdiscovery.org/terms-embed.js';
  var base = src.replace(/\/terms-embed\.js.*$/, '');
  if (!el.hasAttribute('data-no-style')) {
    var css = document.createElement('style');
    css.textContent = '#pd-terms{line-height:1.6}#pd-terms h1{margin:1.6em 0 .5em}#pd-terms h2{margin:1.4em 0 .4em}#pd-terms h3{margin:1.2em 0 .3em}#pd-terms ol,#pd-terms ul{padding-left:1.4em;margin:0 0 1em}#pd-terms li{margin:0 0 .35em}#pd-terms .pd-terms-meta{font-size:.85em;opacity:.7;margin-top:2em}';
    document.head.appendChild(css);
  }
  el.setAttribute('aria-busy', 'true');
  // A specific version (what a family agreed to): data-version="3" or ?v=3.
  var v = el.getAttribute('data-version') || (location.search.match(/[?&]v=(\d{1,6})\b/) || [])[1] || '';
  fetch(base + '/api/terms' + (v ? '?v=' + v : ''), { credentials: 'omit' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (t) {
      var when = t.publishedAt ? new Date(t.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
      el.innerHTML = t.html + '<p class="pd-terms-meta">Version ' + t.version + (when ? ' · updated ' + when : '') + '</p>';
    })
    .catch(function () {
      el.innerHTML = '<p>The terms could not be loaded. Please refresh, or email <a href="mailto:admissions@pacificdiscovery.org">admissions@pacificdiscovery.org</a> for a copy.</p>';
    })
    .then(function () { el.removeAttribute('aria-busy'); });
})();
