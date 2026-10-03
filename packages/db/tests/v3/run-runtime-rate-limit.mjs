/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLocalRateLimit, localRateLimitNames } from './local-rate-limit.mjs';
const tag = `graylum-rl-${randomUUID()}`;
const service = createLocalRateLimit({ tag });
try {
  const environment = await service.start();
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run',
      'src/services/runtimeRateLimiter.local.test.ts'], {
      env: { ...process.env, ...environment, RUNTIME_RATE_LIMIT_LOCAL: 'true',
        RUNTIME_RATE_LIMIT_SRH: localRateLimitNames(tag).rest }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let pending = '';
      input.on('data', chunk => {
        pending += chunk.toString();
        const end = pending.lastIndexOf('\n') + 1;
        if (end) { output.write(service.redact(pending.slice(0, end))); pending = pending.slice(end); }
      });
      input.on('end', () => { if (pending) output.write(service.redact(pending)); });
    }
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally { service.cleanup(); }
