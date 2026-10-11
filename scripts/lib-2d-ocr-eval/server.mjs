// Local static server: harness page, sandbox page (strict CSP), assets, leak recorder.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
export const leaks = [];
const SANDBOX_SCRIPT = `
const send = (m, t) => parent.postMessage(m, '*', t || []);
document.addEventListener('securitypolicyviolation', (e) => send({ type: 'csp', directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 80) }));
let w = null;
onmessage = (ev) => {
  if (ev.source !== parent) return;
  const d = ev.data;
  if (d.type === 'boot') {
    try {
      const url = URL.createObjectURL(new Blob([d.code], { type: 'text/javascript' }));
      w = new Worker(url, { type: d.module ? 'module' : 'classic' });
      w.onmessage = (m) => send(m.data);
      w.onerror = (e) => send({ type: 'error', msg: 'worker error: ' + (e.message || 'unknown') });
      send({ type: 'booted' });
    } catch (e) { send({ type: 'error', msg: 'boot failed: ' + e.message }); }
    return;
  }
  if (d.type === 'page-probe') {
    const r = {};
    try { const i = new Image(); i.src = d.base + '/leak?via=sandbox-img'; r.img = 'attempted'; } catch (e) { r.img = 'blocked'; }
    try {
      fetch(d.base + '/leak?via=sandbox-fetch').then(() => send({ type: 'note', msg: 'sandbox fetch SENT' }), () => {});
      r.fetch = 'attempted';
    } catch (e) { r.fetch = 'blocked'; }
    try { r.cookie = document.cookie; } catch (e) { r.cookie = 'blocked: ' + e.name; }
    try { r.localStorage = String(localStorage.length); } catch (e) { r.localStorage = 'blocked: ' + e.name; }
    try { top.location.href = d.base + '/leak?via=top-nav'; r.topNav = 'attempted'; } catch (e) { r.topNav = 'blocked: ' + e.name; }
    send({ type: 'page-probe', result: r });
    return;
  }
  const { transfer, ...msg } = d; w.postMessage(msg, transfer || []);
};`;
const HASH = crypto.createHash('sha256').update(SANDBOX_SCRIPT).digest('base64');
export function csp(variant) {
  const wasm = variant === 'wasm' ? " 'wasm-unsafe-eval'" : '';
  return ["default-src 'none'", `script-src 'sha256-${HASH}'${wasm}`, 'worker-src blob:', "connect-src 'none'", "img-src 'none'",
    "style-src 'none'", "form-action 'none'", "base-uri 'none'"].join('; ');
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.txt': 'text/plain' };
export function start(port = 0) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/leak') {
      leaks.push(u.search);
      res.end('leak');
      return;
    }
    if (u.pathname === '/sandbox.html') {
      res.setHeader('Content-Security-Policy', csp(u.searchParams.get('csp')));
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><meta charset="utf-8"><script>${SANDBOX_SCRIPT}</script>`);
      return;
    }
    const map = {
      '/a/': path.join(ROOT, 'assets/'),
      '/set/': path.join(ROOT, 'set/'),
      '/dist/': path.join(ROOT, 'dist/'),
      '/nm/': path.join(ROOT, 'node_modules/'),
      '/': path.join(ROOT, 'web/'),
    };
    const pref = Object.keys(map).find((p) => u.pathname.startsWith(p));
    const f = path.join(map[pref], decodeURIComponent(u.pathname.slice(pref.length)) || 'index.html');
    if (!f.startsWith(map[pref]) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}
