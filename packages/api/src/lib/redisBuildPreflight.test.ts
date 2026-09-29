import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = fileURLToPath(new URL('../../../../apps/web/', import.meta.url));
const loadBuildConfig = `
  const loadConfig = require('next/dist/server/config').default;
  const { PHASE_PRODUCTION_BUILD } = require('next/constants');
  loadConfig(PHASE_PRODUCTION_BUILD, process.cwd())
    .then(() => console.log('BUILD_CONFIG_ACCEPTED'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
`;

// Exercise Next's actual config loader with synthetic values, without building,
// loading credentials from the parent process, or contacting Redis/providers.
function runPreflight(overrides: Record<string, string>) {
  try {
    return { ok: true, output: execFileSync(process.execPath, ['-e', loadBuildConfig], {
      cwd: webDir,
      env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ...overrides },
      encoding: 'utf8', stdio: 'pipe', timeout: 30_000,
    }) };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }
}

const redis = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'synthetic-redis-token',
};

describe('deployed Next build Redis preflight', () => {
  it.each(['production', 'preview', 'staging'])('rejects missing credentials in %s', (target) => {
    const result = runPreflight({ VERCEL: '1', VERCEL_ENV: target });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('UPSTASH_REDIS_REST_URL');
    expect(result.output).toContain('UPSTASH_REDIS_REST_TOKEN');
  }, 30_000);

  it.each(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'])('rejects a missing %s', (key) => {
    const env: Record<string, string> = { VERCEL: '1', ...redis };
    delete env[key];
    const result = runPreflight(env);
    expect(result.ok).toBe(false);
    expect(result.output).toContain(key);
    expect(result.output).not.toContain('synthetic-redis-token');
  }, 30_000);

  it('rejects malformed values without printing them', () => {
    const result = runPreflight({ VERCEL_TARGET_ENV: 'staging',
      UPSTASH_REDIS_REST_URL: 'redis://synthetic-private-host',
      UPSTASH_REDIS_REST_TOKEN: 'synthetic secret token' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('UPSTASH_REDIS_REST_URL');
    expect(result.output).toContain('UPSTASH_REDIS_REST_TOKEN');
    expect(result.output).not.toContain('synthetic-private-host');
    expect(result.output).not.toContain('synthetic secret token');
  }, 30_000);

  it('accepts a syntactically valid pair without contacting Redis', () => {
    const result = runPreflight({ VERCEL: '1', VERCEL_ENV: 'production', ...redis });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('BUILD_CONFIG_ACCEPTED');
  }, 30_000);

  it('allows secretless local CI builds; request-side limits still fail closed', () => {
    expect(runPreflight({ CI: 'true' }).ok).toBe(true);
  }, 30_000);
});
