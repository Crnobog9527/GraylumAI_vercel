import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';
// The matcher Next.js uses for header sources.
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

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
    const globalRules = rules.filter(rule => rule.source === '/:path*');
    const headers = Object.fromEntries(globalRules.flatMap(rule => rule.headers).map(({ key, value }) => [key, value]));
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toBe('max-age=2592000');
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Permissions-Policy']).toContain('microphone=()');
    expect(headers['Permissions-Policy']).toContain('geolocation=()');
    expect(headers).not.toHaveProperty('Content-Security-Policy');
    const csp = headers['Content-Security-Policy-Report-Only'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('https://*.supabase.co');
    expect(csp).toContain('wss://*.supabase.co');
    expect(csp).not.toContain('hcaptcha'); // BOT-GUARD: no captcha script, frame or call
    // VOICE-2 PR-7 (Owner 2026-11-14 "同意放开"): only the Google picker's named hosts, never a wildcard; still report-only.
    expect(csp).toContain("frame-src 'self' https://docs.google.com https://accounts.google.com;");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://apis.google.com https://accounts.google.com;");
    expect(csp).toContain('https://www.googleapis.com https://content.googleapis.com');
    expect(csp).not.toMatch(/https:\/\/\*\.google(apis)?\.com/);
    expect(csp).toContain('https://*.ingest.sentry.io');
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toContain('termly.io');
    expect(csp).toContain('https://*.google-analytics.com');
    expect(rules.find(rule => rule.source.startsWith('/fonts/misans/'))?.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
    ]);
  });

  it.each([undefined, '', 'true', 'Public', ' public'])('keeps every path noindex when SITE_INDEXING is %j', async value => {
    vi.stubEnv('SITE_INDEXING', value);
    const rules = await (await loadConfig())(PHASE_DEVELOPMENT_SERVER).headers!();
    const robotsRules = rules.filter(rule => rule.headers.some(header => header.key === 'X-Robots-Tag'));
    expect(robotsRules).toEqual([{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }]);
  });

  it('keeps noindex only on logged-in, login and status pages when SITE_INDEXING is public', async () => {
    vi.stubEnv('SITE_INDEXING', 'public');
    const rules = await (await loadConfig())(PHASE_DEVELOPMENT_SERVER).headers!();
    const robotsRules = rules.filter(rule => rule.headers.some(header => header.key === 'X-Robots-Tag'));
    const noindexed = (path: string) => robotsRules.some(rule => getPathMatch(rule.source)(path) !== false);
    for (const path of ['/app', '/app/positioning', '/admin', '/admin/users', '/auth/callback', '/login', '/register',
      '/verify-email', '/forgot-password', '/reset-password', '/maintenance', '/access-denied', '/profile', '/positioning']) {
      expect(noindexed(path), path).toBe(true);
    }
    for (const path of ['/', '/landing', '/landing/pricing', '/faq', '/zh-tw', '/zh-tw/ig-jingying', '/about', '/application',
      '/login-help', '/sitemap.xml', '/robots.txt']) {
      expect(noindexed(path), path).toBe(false);
    }
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

describe('VERCEL-COST-2: type checking in the build', () => {
  it('is skipped only on Vercel; local and CI builds still check types', async () => {
    vi.stubEnv('VERCEL', '1');
    expect((await loadConfig())(PHASE_PRODUCTION_BUILD).typescript?.ignoreBuildErrors).toBe(true);
    vi.unstubAllEnvs(); vi.resetModules();
    vi.stubEnv('VERCEL', '');
    expect((await loadConfig())(PHASE_PRODUCTION_BUILD).typescript?.ignoreBuildErrors).toBe(false);
    vi.unstubAllEnvs(); vi.resetModules();
    vi.stubEnv('CI', 'true');
    expect((await loadConfig())(PHASE_PRODUCTION_BUILD).typescript?.ignoreBuildErrors).toBe(false);
  });
});

describe('moved public pages', () => {
  it('sends the old pricing address /landing/pricing to /pricing for good (308, the query kept by Next.js)', async () => {
    const config = (await loadConfig())(PHASE_DEVELOPMENT_SERVER);
    const rules = await config.redirects!();
    expect(rules).toContainEqual({ source: '/landing/pricing', destination: '/pricing', permanent: true });
    // No chain: nothing redirects /pricing itself.
    expect(rules.some(rule => getPathMatch(rule.source)('/pricing'))).toBe(false);
  });

  it('sends the removed acceptable-use placeholder page to the terms section on prohibited activities', async () => {
    const config = (await loadConfig())(PHASE_DEVELOPMENT_SERVER);
    const rules = await config.redirects!();
    expect(rules).toContainEqual({ source: '/acceptable-use', destination: '/terms#sec-7', permanent: true });
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

describe('development server page retention (simulated-model browser tests)', () => {
  it('keeps compiled pages only when the sim switch is set, and never in a build', async () => {
    expect((await loadConfig())(PHASE_DEVELOPMENT_SERVER).onDemandEntries).toBeUndefined();
    vi.stubEnv('SIM_KEEP_COMPILED', '1');
    vi.resetModules();
    const kept = (await loadConfig())(PHASE_DEVELOPMENT_SERVER).onDemandEntries;
    expect(kept?.maxInactiveAge).toBeGreaterThan(60 * 60 * 1000);
    expect(kept?.pagesBufferLength).toBeGreaterThanOrEqual(100);
  });

  it('writes no compile cache to disk only when the sim switch is set, and only in the development server', async () => {
    expect((await loadConfig())(PHASE_DEVELOPMENT_SERVER).webpack).toBeUndefined();
    expect((await loadConfig())(PHASE_PRODUCTION_BUILD).webpack).toBeUndefined();
    vi.stubEnv('SIM_KEEP_COMPILED', '1');
    vi.resetModules();
    const webpack = (await loadConfig())(PHASE_DEVELOPMENT_SERVER).webpack as unknown as
      (config: { cache: unknown; name: string }, context: { dev: boolean }) => { cache: unknown; name: string };
    const disk = { type: 'filesystem', cacheDirectory: '/tmp/x' };
    // The same config object comes back, with only its cache switched off: the memory cache Next adds itself is a plugin, not this option.
    const input = { cache: disk, name: 'server' };
    expect(webpack(input, { dev: true })).toBe(input);
    expect(input.cache).toBe(false);
    // Outside the development server the compiler's cache is left as it is.
    expect(webpack({ cache: disk, name: 'server' }, { dev: false }).cache).toBe(disk);
  });
});
