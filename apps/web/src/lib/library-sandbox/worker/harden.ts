/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Defence in depth for parser Workers, imported before any parser module. The sandbox CSP
 * (`connect-src 'none'`, hash-only `script-src`) is what actually blocks network and script loading;
 * this only removes the obvious entry points so a library cannot even try them.
 */
const REMOVED = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches',
] as const;

function lock(name: string, value: unknown) {
  try {
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
  } catch {
    // Some globals are non-configurable in some engines; the CSP still applies.
  }
}

for (const name of REMOVED) lock(name, undefined);
// Kept as a function: polyfills (setimmediate in JSZip) detect a Worker by its presence.
lock('importScripts', () => {
  throw new TypeError('importScripts is disabled in the library sandbox');
});

export {};
