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
// Said by every process that loads this preload (the server and what it forks), so run.mjs can report the heap limit the server really has.
console.log('[sim-preload] heap_size_limit_mb=' + Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 1048576));
