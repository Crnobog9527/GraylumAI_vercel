import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';

const { withSentryConfig, validateRedisEnvForBuild } = vi.hoisted(() => ({
  withSentryConfig: vi.fn((config, _options) => config),
  validateRedisEnvForBuild: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ withSentryConfig }));
vi.mock('../../packages/api/src/lib/envValidator', () => ({ validateRedisEnvForBuild }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadConfig() {
  const { default: config } = await import('./next.config');
  return config as unknown as (phase: string) => import('next').NextConfig;
}

describe('security response headers', () => {
  it('reports resource CSP, denies embedding, and preserves immutable font caching', async () => {
    const config = (await loadConfig())(PHASE_DEVELOPMENT_SERVER);
    const rules = await config.headers!();
    const globalRule = rules.find(rule => rule.source === '/:path*');
    const headers = Object.fromEntries(globalRule!.headers.map(({ key, value }) => [key, value]));
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toBe('max-age=2592000');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Permissions-Policy']).toContain('microphone=()');
    expect(headers['Permissions-Policy']).toContain('geolocation=()');
    expect(headers).not.toHaveProperty('Content-Security-Policy');
    const csp = headers['Content-Security-Policy-Report-Only'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('https://*.supabase.co');
    expect(csp).toContain('wss://*.supabase.co');
    expect(csp).toContain('https://*.hcaptcha.com');
    expect(csp).toContain('https://*.ingest.sentry.io');
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(rules.find(rule => rule.source.startsWith('/fonts/misans/'))?.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
    ]);
  });

  it('keeps the Redis prerequisite on production builds only', async () => {
    const config = await loadConfig();
    config(PHASE_DEVELOPMENT_SERVER);
    expect(validateRedisEnvForBuild).not.toHaveBeenCalled();
    config(PHASE_PRODUCTION_BUILD);
    expect(validateRedisEnvForBuild).toHaveBeenCalledOnce();
    validateRedisEnvForBuild.mockImplementationOnce(() => { throw new Error('missing Redis'); });
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow('missing Redis');
  });
});

describe('Sentry build upload opt-in', () => {
  it.each([
    ['false', true, false],
    ['true', false, false],
    ['true', true, true],
  ])('upload flag %s and complete credentials %s => upload %s', async (flag, complete, enabled) => {
    vi.stubEnv('ENABLE_SENTRY_BUILD_UPLOAD', flag);
    for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
      vi.stubEnv(key, complete ? 'test-placeholder' : '');
    }
    await loadConfig();
    const options = withSentryConfig.mock.calls[0][1];
    expect(options).toMatchObject({
      telemetry: false,
      tunnelRoute: '/monitoring',
      widenClientFileUpload: enabled,
      sourcemaps: { disable: !enabled },
      release: { create: enabled, finalize: enabled },
    });
    expect(options).not.toHaveProperty('hideSourceMaps');
  });
});
