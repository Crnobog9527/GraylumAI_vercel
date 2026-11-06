/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Loaded into the local Next process with NODE_OPTIONS=--require for the simulated-model browser tests (layer 1). The app's own
// code is unchanged: its fixed official endpoint https://openrouter.ai is answered by the local simulator (SIM_ORIGIN), and any
// other non-loopback request fails, so no real provider, supplier or service can be reached or billed from this process.
const sim = process.env.SIM_ORIGIN;
if (!sim || new URL(sim).hostname !== '127.0.0.1') throw new Error('SIM_ORIGIN must be a loopback address');
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'https://openrouter.ai') {
    const mapped = sim + url.pathname + url.search;
    return original(input instanceof Request ? new Request(mapped, input) : mapped, init);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('SIM_LOCAL_ONLY_NETWORK ' + url.hostname));
  return original(input, init);
};
// Measurement for run.mjs (dev-server-memory.mjs): only the Next server process says its heap limit, at start and then its used heap every
// 30 seconds. On stderr, and not from the other processes that load this preload (`tsc --showConfig`'s stdout is parsed as JSON by Next).
if (/start-server\.js$/.test(process.argv[1] ?? '')) {
  const v8 = require('node:v8');
  const mb = bytes => Math.round(bytes / 1048576);
  console.error('[sim-preload] heap_size_limit_mb=' + mb(v8.getHeapStatistics().heap_size_limit));
  setInterval(() => console.error('[sim-preload] heap_used_mb=' + mb(v8.getHeapStatistics().used_heap_size)), 30_000).unref();
}
