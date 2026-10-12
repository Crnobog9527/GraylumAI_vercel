import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRobots, SEARCH_CRAWLERS, TRAINING_CRAWLERS } from './robots-policy';
import robots from '@/app/robots';

afterEach(() => {
  vi.unstubAllEnvs();
});

const closed = { rules: [{ userAgent: '*', disallow: '/' }] };

describe('robots policy', () => {
  it('refuses every crawler unless the switch is exactly public', () => {
    for (const value of [undefined, '', ' ', 'true', '1', 'Public', 'PUBLIC', 'private', 'public,staging', ' public', 'public\n', ' public\n']) {
      expect(buildRobots(value)).toEqual(closed);
    }
  });

  it('refuses training crawlers and allows search crawlers when public', () => {
    expect(buildRobots('public')).toEqual({
      rules: [
        { userAgent: [...TRAINING_CRAWLERS], disallow: '/' },
        { userAgent: [...SEARCH_CRAWLERS], allow: '/', disallow: ['/api/'] },
        { userAgent: '*', allow: '/', disallow: ['/api/'] },
      ],
      sitemap: 'https://www.graylum.com/sitemap.xml',
    });
    expect(TRAINING_CRAWLERS).toEqual(expect.arrayContaining(['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot']));
    expect(TRAINING_CRAWLERS).toEqual(expect.arrayContaining(['Amazonbot', 'cohere-ai', 'Diffbot', 'omgili', 'Bytespider']));
    expect(SEARCH_CRAWLERS).toEqual(expect.arrayContaining(['ChatGPT-User', 'Claude-User', 'Perplexity-User', 'DuckAssistBot', 'Applebot']));
    expect(SEARCH_CRAWLERS).toEqual(expect.arrayContaining(['Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot']));
    expect(TRAINING_CRAWLERS.filter(bot => (SEARCH_CRAWLERS as readonly string[]).includes(bot))).toEqual([]);
  });

  it('never disallows logged-in or login pages or the assets public pages render with', () => {
    // Crawlers must fetch these pages to read their noindex (SEO_GEO_SPEC sections 2 and 11).
    const rules = [buildRobots('public').rules].flat();
    const disallowed = rules.flatMap(rule => (rule.userAgent === '*' ? [rule.disallow ?? []].flat() : []));
    expect(disallowed).toEqual(['/api/']);
  });

  it('reads the server switch at request time', () => {
    vi.stubEnv('SITE_INDEXING', undefined);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(robots()).toEqual(closed);
    vi.stubEnv('SITE_INDEXING', 'public');
    expect(robots()).toEqual(buildRobots('public'));
  });
});
