import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRobots, SEARCH_CRAWLERS, TRAINING_CRAWLERS } from './robots-policy';
import robots from '@/app/robots';

afterEach(() => {
  vi.unstubAllEnvs();
});

const closed = { rules: [{ userAgent: '*', disallow: '/' }] };

describe('robots policy', () => {
  it('refuses every crawler unless the switch is exactly public', () => {
    for (const value of [undefined, '', ' ', 'true', '1', 'Public', 'PUBLIC', 'private', 'public,staging']) {
      expect(buildRobots(value)).toEqual(closed);
    }
  });

  it('refuses training crawlers and allows search crawlers when public', () => {
    for (const value of ['public', ' public\n']) {
      expect(buildRobots(value)).toEqual({
        rules: [
          { userAgent: [...TRAINING_CRAWLERS], disallow: '/' },
          { userAgent: [...SEARCH_CRAWLERS], allow: '/' },
          { userAgent: '*', allow: '/' },
        ],
      });
    }
    expect(TRAINING_CRAWLERS).toEqual(expect.arrayContaining(['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot']));
    expect(SEARCH_CRAWLERS).toEqual(expect.arrayContaining(['Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot']));
    expect(TRAINING_CRAWLERS.filter(bot => (SEARCH_CRAWLERS as readonly string[]).includes(bot))).toEqual([]);
  });

  it('reads the server switch at request time', () => {
    vi.stubEnv('SITE_INDEXING', undefined);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(robots()).toEqual(closed);
    vi.stubEnv('SITE_INDEXING', 'public');
    expect(robots()).toEqual(buildRobots('public'));
  });
});
