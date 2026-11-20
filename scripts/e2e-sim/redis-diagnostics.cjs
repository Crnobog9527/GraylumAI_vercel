/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only observation; preserve rejection and omit URLs, commands, keys, tokens and error messages.
if (process.env.SIM_REDIS_ORIGIN) {
  const localRedis = new URL(process.env.SIM_REDIS_ORIGIN);
  if (localRedis.protocol !== 'http:' || localRedis.hostname !== '127.0.0.1' || !localRedis.port) throw new Error('invalid local Redis diagnostic target');
  const measuredFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let origin;
    try { origin = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin; } catch { return measuredFetch(input, init); }
    if (origin !== localRedis.origin) return measuredFetch(input, init);
    return measuredFetch(input, init).catch(error => {
      const category = ['AbortError', 'TimeoutError', 'TypeError'].includes(error?.name) ? error.name : 'Other';
      console.error(`[sim-rate] local Redis fetch rejected: ${category}`);
      throw error;
    });
  };
}
