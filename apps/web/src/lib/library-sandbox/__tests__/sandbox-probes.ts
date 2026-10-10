/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Hostile code used by sandbox.browser.test.ts. It runs inside the real sandbox (same CSP, same
// iframe attributes, same relay protocol) and tries every request and storage channel it can.

const ATTEMPT = `
  var report = {};
  function attempt(name, fn) {
    return new Promise(function (resolve) {
      var done = function (value) { if (!(name in report)) report[name] = value; resolve(); };
      setTimeout(function () { done('no-response'); }, 2000);
      try {
        Promise.resolve(fn()).then(function (value) { done('ALLOWED:' + String(value).slice(0, 60)); },
          function (error) { done('blocked:' + (error && error.name)); });
      } catch (error) { done('blocked:' + (error && error.name)); }
    });
  }
  function trigger(name, fn) {
    try { fn(); report[name] = 'triggered'; } catch (error) { report[name] = 'threw:' + (error && error.name); }
  }`;

const NETWORK = (target: string) => `
  await attempt('fetch', function () { return fetch('${target}/fetch').then(function (r) { return r.status; }); });
  await attempt('fetchNoCors', function () { return fetch('${target}/no-cors', { mode: 'no-cors' }).then(function (r) { return r.type; }); });
  await attempt('xhr', function () { return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest(); x.open('GET', '${target}/xhr');
    x.onload = function () { resolve(x.status); }; x.onerror = function () { reject(new Error('xhr')); }; x.send(); }); });
  await attempt('websocket', function () { return new Promise(function (resolve, reject) {
    var ws = new WebSocket('${target.replace('http', 'ws')}/ws');
    ws.onopen = function () { resolve('open'); }; ws.onerror = function () { reject(new Error('ws')); }; }); });
  await attempt('eventSource', function () { return new Promise(function (resolve, reject) {
    var es = new EventSource('${target}/sse');
    es.onopen = function () { resolve('open'); }; es.onerror = function () { es.close(); reject(new Error('sse')); }; }); });`;

/** Worker source: network, script loading, eval and storage from inside the parser Worker. */
export function workerProbe(target: string): string {
  return `(async function () {
  ${ATTEMPT}
  ${NETWORK(target)}
  await attempt('importScripts', function () { importScripts('${target}/import.js'); return 'loaded'; });
  await attempt('eval', function () { return eval('1 + 1'); });
  await attempt('newFunction', function () { return new Function('return 2')(); });
  await attempt('nestedWorker', function () { return new Promise(function (resolve, reject) {
    var w = new Worker('${target}/nested.js'); w.onerror = function () { reject(new Error('worker')); };
    setTimeout(function () { resolve('created'); }, 500); }); });
  await attempt('indexedDB', function () { return new Promise(function (resolve, reject) {
    var r = indexedDB.open('probe'); r.onsuccess = function () { resolve('opened'); }; r.onerror = function () { reject(new Error('idb')); }; }); });
  await attempt('caches', function () { return caches.open('probe').then(function () { return 'opened'; }); });
  report.locationAssign = (function () { try { self.location = '${target}/nav'; } catch (error) { return 'threw:' + error.name; }
    return String(self.location).indexOf('${target}') === 0 ? 'NAVIGATED' : 'ignored'; })();
  postMessage({ ok: true, value: report });
})();`;
}

/** Relay replacement: the same requests from the frame document, plus DOM-driven loads and storage. */
export function frameProbe(target: string): string {
  return `(async function () {
  var token = document.querySelector('meta[name="graylum-sandbox-token"]').getAttribute('content');
  var channel = new MessageChannel();
  parent.postMessage({ type: 'graylum-sandbox:ready', token: token }, '*', [channel.port2]);
  ${ATTEMPT}
  ${NETWORK(target)}
  trigger('image', function () { var i = new Image(); i.src = '${target}/image'; document.body.appendChild(i); });
  trigger('stylesheet', function () { var l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = '${target}/style.css'; document.head.appendChild(l); });
  trigger('prefetch', function () { var l = document.createElement('link'); l.rel = 'prefetch';
    l.href = '${target}/prefetch'; document.head.appendChild(l); });
  trigger('script', function () { var s = document.createElement('script'); s.src = '${target}/script.js'; document.head.appendChild(s); });
  trigger('childFrame', function () { var f = document.createElement('iframe'); f.src = '${target}/frame'; document.body.appendChild(f); });
  trigger('form', function () { var f = document.createElement('form'); f.method = 'post'; f.action = '${target}/form';
    document.body.appendChild(f); f.submit(); });
  trigger('popup', function () { report.popupHandle = window.open('${target}/popup') === null ? 'null' : 'window'; });
  trigger('anchorBlank', function () { var a = document.createElement('a'); a.href = '${target}/anchor'; a.target = '_blank';
    document.body.appendChild(a); a.click(); });
  trigger('topNavigation', function () { top.location.href = '${target}/top'; });
  trigger('beacon', function () { report.beaconQueued = navigator.sendBeacon('${target}/beacon', 'x'); });
  trigger('cssBackground', function () { document.body.style.backgroundImage = 'url(${target}/background)'; });
  trigger('media', function () { new Audio('${target}/audio').play().catch(function () {}); });
  trigger('cookie', function () { return document.cookie; });
  trigger('localStorage', function () { return localStorage.length; });
  trigger('parentDocument', function () { return parent.document.title; });
  report.origin = String(self.origin);
  setTimeout(function () {
    channel.port1.postMessage({ type: 'graylum-sandbox:result', token: token, data: { ok: true, value: report } });
  }, 1500);
})();`;
}

/** Relay replacement that navigates its own frame away, before (`early`) or after the handshake. */
export function selfNavigationProbe(target: string, early: boolean): string {
  if (early) return `location.href = '${target}/early-navigation';`;
  return `var token = document.querySelector('meta[name="graylum-sandbox-token"]').getAttribute('content');
  var channel = new MessageChannel();
  channel.port1.onmessage = function () { location.href = '${target}/late-navigation'; };
  parent.postMessage({ type: 'graylum-sandbox:ready', token: token }, '*', [channel.port2]);`;
}

export const HANG_WORKER = 'for (;;) {}';
export const GARBAGE_WORKER = "postMessage({ ok: true });";
export const FAKE_CODE_WORKER = "postMessage({ ok: false, code: 'NOT_A_REAL_CODE' });";
export const THROWING_WORKER = "throw new Error('boom');";
