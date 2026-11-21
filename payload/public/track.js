/*!
 * Activemur · track.js — medición first-party sin dependencias.
 * Uso:
 *   <script>window.AV_TRACK={endpoint:"https://crm...", site:"activemur.es"}</script>
 *   <script src="https://crm.../track.js" defer></script>
 * API: window.avTrack(evento, props) · window.avAttr() · window.avConsent(granted|denied)
 *
 * Privacidad: sin consentimiento no se escribe ninguna cookie ni identificador persistente.
 * No envía nombres, teléfonos ni emails. La IP se convierte en hash diario en el servidor.
 */
(function () {
  'use strict';
  var CFG = window.AV_TRACK || {};
  var ENDPOINT = (CFG.endpoint || '').replace(/\/$/, '');
  if (!ENDPOINT) return; // sin backend configurado no se inventa nada

  var VID_KEY = 'av_vid', ATTR_KEY = 'av_attr', CONSENT_KEY = 'av_consent';
  var DAYS_VID = 396, DAYS_ATTR = 90;
  var memVid = null, memAttr = null, started = false, scrolled = false;

  function nowIso() { return new Date().toISOString(); }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function writeCookie(name, value, days) {
    var d = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; Path=/; Expires=' + d + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }

  function consent() {
    if (typeof CFG.consent === 'function') return CFG.consent();
    if (window.avConsentState) return window.avConsentState;
    try { return localStorage.getItem(CONSENT_KEY) || 'unknown'; } catch (e) { return 'unknown'; }
  }
  function hasConsent() { return consent() === 'granted'; }

  window.avConsent = function (state) {
    try { localStorage.setItem(CONSENT_KEY, state); } catch (e) {}
    window.avConsentState = state;
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function vid() {
    if (hasConsent()) {
      var v = readCookie(VID_KEY);
      if (!v) { v = uuid(); writeCookie(VID_KEY, v, DAYS_VID); }
      return v;
    }
    if (!memVid) memVid = uuid(); // efímero: se pierde al recargar
    return memVid;
  }

  function params() {
    var out = {}, q;
    try { q = new URLSearchParams(location.search); } catch (e) { return out; }
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
     'gclid', 'fbclid', 'msclkid'].forEach(function (k) {
      var v = q.get(k);
      if (v) out[k] = String(v).slice(0, 400);
    });
    return out;
  }

  function touch() {
    var p = params();
    var t = {
      utm_source: p.utm_source || null, utm_medium: p.utm_medium || null,
      utm_campaign: p.utm_campaign || null, utm_content: p.utm_content || null,
      utm_term: p.utm_term || null, gclid: p.gclid || null, fbclid: p.fbclid || null,
      msclkid: p.msclkid || null,
      landing_page: location.pathname + location.search,
      referrer: document.referrer || null,
      at: nowIso()
    };
    var hasSignal = p.utm_source || p.gclid || p.fbclid || p.msclkid;
    if (hasSignal) {
      if (hasConsent()) { try { writeCookie(ATTR_KEY, JSON.stringify(t), DAYS_ATTR); } catch (e) {} }
      memAttr = t;
      return t;
    }
    if (memAttr) return memAttr;
    if (hasConsent()) {
      var raw = readCookie(ATTR_KEY);
      if (raw) { try { memAttr = JSON.parse(raw); return memAttr; } catch (e) {} }
    }
    memAttr = t;
    return t;
  }

  function send(event, extra) {
    var t = touch();
    var payload = {
      vid: vid(), event: event, at: nowIso(),
      path: location.pathname + location.search,
      referrer: document.referrer || null,
      host: location.host,
      device: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      consent: hasConsent() ? 1 : 0
    };
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'msclkid']
      .forEach(function (k) { if (t[k] && !payload[k]) payload[k] = t[k]; });
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];

    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT + '/api/track', new Blob([body], { type: 'text/plain;charset=UTF-8' }));
        return;
      }
    } catch (e) {}
    try {
      fetch(ENDPOINT + '/api/track', {
        method: 'POST', body: body, keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      });
    } catch (e) {}
  }

  window.avTrack = send;

  /* Atribución lista para el formulario. */
  window.avAttr = function () {
    var t = touch();
    return {
      vid: vid(), utm_source: t.utm_source, utm_medium: t.utm_medium,
      utm_campaign: t.utm_campaign, utm_content: t.utm_content, utm_term: t.utm_term,
      gclid: t.gclid, fbclid: t.fbclid, msclkid: t.msclkid,
      landing_page: t.landing_page, referrer: t.referrer,
      consent: hasConsent() ? 1 : 0
    };
  };

  /* ---------- automedición ---------- */
  send('page_view');

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href], [data-track]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var label = (a.getAttribute('data-track') || a.textContent || '').trim().slice(0, 80);
    var evt = null;
    if (href.indexOf('tel:') === 0) evt = 'phone_click';
    else if (/wa\.me|whatsapp/i.test(href)) evt = 'whatsapp_click';
    else if (a.hasAttribute('data-track')) evt = 'cta_click';
    if (evt) send(evt, { label: label, target: href.slice(0, 200) });
  }, true);

  document.addEventListener('focusin', function (e) {
    if (started) return;
    if (e.target && e.target.closest && e.target.closest('form')) {
      started = true;
      send('form_start', { form: (e.target.form && e.target.form.id) || 'form' });
    }
  }, true);

  document.addEventListener('submit', function (e) {
    if (e.target && e.target.closest) {
      send('form_submit', { form: e.target.id || 'form' });
    }
  }, true);

  window.addEventListener('scroll', function () {
    if (scrolled) return;
    var h = document.documentElement;
    var pct = (h.scrollTop + window.innerHeight) / Math.max(1, h.scrollHeight);
    if (pct >= 0.75) { scrolled = true; send('scroll_75'); }
  }, { passive: true });
})();
