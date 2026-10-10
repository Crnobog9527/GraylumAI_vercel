/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { MESSAGE } from './protocol';

/**
 * The sandboxed relay document (LIB_DOCS_PLAN §4.1). It is loaded through `srcdoc` into an
 * `<iframe sandbox="allow-scripts">` (opaque origin: no cookies, storage or Graylum credentials).
 * Its only script is this fixed relay, allowed by hash; it never touches the DOM or navigation.
 * The parser runs in a Worker started from a blob, which inherits this CSP: no fetch, XHR,
 * WebSocket, EventSource or importScripts. The relay hands the page a MessagePort, then forwards
 * bytes in and one reply out over that port.
 */

export const RELAY_SCRIPT = `(function () {
  'use strict';
  var meta = document.querySelector('meta[name="graylum-sandbox-token"]');
  var token = meta ? meta.getAttribute('content') : null;
  if (!token) return;
  var channel = new MessageChannel();
  var port = channel.port1;
  var worker = null;
  var started = false;
  function send(message) { port.postMessage(message); }
  function stop() { if (worker) { worker.terminate(); worker = null; } }
  function failed() { send({ type: '${MESSAGE.failure}', token: token }); stop(); }
  port.onmessage = function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.token !== token) return;
    if (data.type === '${MESSAGE.abort}') { stop(); port.close(); return; }
    if (data.type !== '${MESSAGE.start}' || started) return;
    if (typeof data.source !== 'string' || !(data.input instanceof ArrayBuffer)) return;
    started = true;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([data.source], { type: 'text/javascript' })));
    } catch (error) { failed(); return; }
    worker.onmessage = function (reply) { send({ type: '${MESSAGE.result}', token: token, data: reply.data }); stop(); };
    worker.onerror = function (error) { error.preventDefault(); failed(); };
    worker.onmessageerror = failed;
    worker.postMessage(data.input, [data.input]);
  };
  // The page talks to this document only through the port: if the frame ever navigated away,
  // nothing sent on it could reach the new document.
  parent.postMessage({ type: '${MESSAGE.ready}', token: token }, '*', [channel.port2]);
})();`;

/** `meta` CSP for the relay frame; the Worker started from a blob inherits it. */
export function sandboxCsp(scriptHash: string): string {
  return [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    'worker-src blob:',
    "connect-src 'none'",
    "img-src 'none'",
    "style-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function buildSandboxSrcdoc(token: string, scriptHash: string, script = RELAY_SCRIPT): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(sandboxCsp(scriptHash))}">`
    + '<meta name="referrer" content="no-referrer">'
    + `<meta name="graylum-sandbox-token" content="${escapeAttribute(token)}">`
    + `<script>${script}</script></head><body></body></html>`;
}

/** CSP source expression for an inline script: `sha256-<base64>`. */
export async function scriptHashSource(script: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

/** Iframe attributes: scripts only. No same-origin, forms, popups, top navigation, downloads or modals. */
export const SANDBOX_FRAME_ATTRIBUTES = {
  sandbox: 'allow-scripts',
  referrerpolicy: 'no-referrer',
  allow: "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
  'aria-hidden': 'true',
  tabindex: '-1',
} as const;
