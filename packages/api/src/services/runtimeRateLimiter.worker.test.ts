/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { checkRuntimeRateLimit } from './redisRateLimiter';
import { DEFAULT_RUNTIME_RATE_LIMITS as defaults } from './runtime/rateLimitSettings';
it.skipIf(process.env.RUNTIME_RATE_LIMIT_WORKER !== 'true')('counts through an independent Node process', async () => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.UPSTASH_REDIS_REST_URL ?? '')) {
    throw new Error('LOCAL_REDIS_REQUIRED');
  }
  const actor = process.env.RUNTIME_RATE_LIMIT_ACTOR!;
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    checkRuntimeRateLimit(actor, 'admission', defaults, 'local')));
  await writeFile(process.env.RUNTIME_RATE_LIMIT_RESULT!, JSON.stringify(results));
});
