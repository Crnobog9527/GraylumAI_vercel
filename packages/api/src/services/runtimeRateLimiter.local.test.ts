/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkRuntimeRateLimit } from './redisRateLimiter';
import { DEFAULT_RUNTIME_RATE_LIMITS as defaults } from './runtime/rateLimitSettings';

// Explicit local-only entry. Normal unit/CI runs never connect to Redis.
const enabled = process.env.RUNTIME_RATE_LIMIT_LOCAL === 'true';
const rest = process.env.RUNTIME_RATE_LIMIT_SRH;
if (enabled && (!rest?.startsWith('graylum-rl-')
  || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.UPSTASH_REDIS_REST_URL ?? ''))) {
  throw new Error('LOCAL_REDIS_REQUIRED');
}
describe.skipIf(!enabled)('Runtime limiter against disposable Redis + SRH', () => {
  let stopped = false;
  afterAll(() => { if (stopped) execFileSync('docker', ['unpause', rest!]); });
  it('shares minute counters across independent limiter calls and isolates identities/environments', async () => {
    const actor = randomUUID();
    const config = { ...defaults, admissionPerMinute: 2 };
    expect(await checkRuntimeRateLimit(actor, 'admission', config, 'local')).toEqual({ success: true });
    expect(await checkRuntimeRateLimit(actor, 'admission', config, 'local')).toEqual({ success: true });
    expect(await checkRuntimeRateLimit(actor, 'admission', config, 'local')).toMatchObject({ window: 'minute' });
    expect(await checkRuntimeRateLimit(randomUUID(), 'admission', config, 'local')).toEqual({ success: true });
    expect(await checkRuntimeRateLimit(actor, 'admission', config, 'staging')).toEqual({ success: true });
  });
  it('never admits more than ten simultaneous messages for one user', async () => {
    const actor = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      checkRuntimeRateLimit(actor, 'admission', defaults, 'local')));
    expect(results.filter(r => r.success)).toHaveLength(10);
    expect(results.filter(r => !r.success).every(r => r.reason === 'rate_limited')).toBe(true);
  });
  it('shares the same counter across two independent Node processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-rate-limit-'));
    const actor = randomUUID();
    try {
      const results = await Promise.all([0, 1].map(async index => {
        const file = join(directory, `${index}.json`);
        await promisify(execFile)('pnpm', ['exec', 'vitest', 'run', 'src/services/runtimeRateLimiter.worker.test.ts'], {
          env: { ...process.env, RUNTIME_RATE_LIMIT_WORKER: 'true', RUNTIME_RATE_LIMIT_ACTOR: actor,
            RUNTIME_RATE_LIMIT_RESULT: file }, timeout: 15000,
        });
        return JSON.parse(await readFile(file, 'utf8')) as Array<{ success: boolean; reason?: string }>;
      }));
      expect(results.flat().filter(result => result.success)).toHaveLength(10);
      expect(results.flat().filter(result => !result.success).every(result => result.reason === 'rate_limited')).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20000);
  it('does not burn the remaining unit when a multi-call round cannot fit', async () => {
    const actor = randomUUID();
    const config = { ...defaults, callsPerMinute: 3 };
    expect(await checkRuntimeRateLimit(actor, 'calls', config, 'local', 2)).toEqual({ success: true });
    for (let i = 0; i < 3; i++) {
      expect(await checkRuntimeRateLimit(actor, 'calls', config, 'local', 2)).toMatchObject({ window: 'minute' });
    }
    expect(await checkRuntimeRateLimit(actor, 'calls', config, 'local', 1)).toEqual({ success: true });
    expect(await checkRuntimeRateLimit(actor, 'calls', config, 'local', 1)).toMatchObject({ window: 'minute' });
  });
  it('preserves counts across configuration edits', async () => {
    const actor = randomUUID();
    const config = { ...defaults, callsPerMinute: 3, callsPer24Hours: 3 };
    expect(await checkRuntimeRateLimit(actor, 'calls', config, 'local', 2)).toEqual({ success: true });
    const raised = { ...config, callsPerMinute: 4, callsPer24Hours: 4 };
    expect(await checkRuntimeRateLimit(actor, 'calls', raised, 'local', 2)).toEqual({ success: true });
    expect(await checkRuntimeRateLimit(actor, 'calls', config, 'local')).toMatchObject({ window: 'minute' });
    expect(await checkRuntimeRateLimit(actor, 'calls', { ...raised, callsPerMinute: 5, callsPer24Hours: 5 }, 'local'))
      .toEqual({ success: true });
  });
  it('multi-call precheck races can only overcount, never allow more rounds', async () => {
    const actor = randomUUID();
    const config = { ...defaults, callsPerMinute: 10 };
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      checkRuntimeRateLimit(actor, 'calls', config, 'local', 3)));
    expect(results.filter(r => r.success).length).toBeLessThanOrEqual(3);
    expect(results.filter(r => r.success).length).toBeGreaterThan(0);
  });
  it('denies while SRH is down, then recovers without a fallback counter', async () => {
    // Freeze SRH so the endpoint stops responding without Docker reallocating its ephemeral port.
    execFileSync('docker', ['pause', rest!]);
    stopped = true;
    expect(await checkRuntimeRateLimit(randomUUID(), 'admission', defaults, 'local'))
      .toMatchObject({ success: false, reason: 'unavailable', retryAfter: 60 });
    execFileSync('docker', ['unpause', rest!]);
    stopped = false;
    // Poll only the read-only PING until the resumed service answers.
    const url = process.env.UPSTASH_REDIS_REST_URL!;
    await expect.poll(async () => {
      try {
        const response = await fetch(url, { method: 'POST',
          headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(['PING']), signal: AbortSignal.timeout(1000) });
        return (await response.json()).result;
      } catch { return null; }
    }).toBe('PONG');
    expect(await checkRuntimeRateLimit(randomUUID(), 'admission', defaults, 'local')).toEqual({ success: true });
  }, 20000);
});
