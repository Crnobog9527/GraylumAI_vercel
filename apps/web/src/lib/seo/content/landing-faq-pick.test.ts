import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.resetModules(); vi.doUnmock('@/lib/landing/landing-flags'); });

describe('landing FAQ reuse follows the landing switches', () => {
  it('returns the answers by id, never the founder ones', async () => {
    const { landingFaq } = await import('./landing-faq-pick');
    expect(landingFaq('faq-2').map(item => item.question)).toEqual(['我没做过账号，也不会用 AI，能用吗？']);
    expect(landingFaq('faq-15', 'faq-16')).toEqual([]);
    expect(() => landingFaq('faq-99')).toThrow();
  });

  it('leaves an answer out when a capability it promises is switched off, and drops the 500 credits with signupGrant', async () => {
    vi.doMock('@/lib/landing/landing-flags', async importOriginal => {
      const original = await importOriginal<typeof import('@/lib/landing/landing-flags')>();
      return { ...original, resolveLandingFlags: () => ({ ...original.resolveLandingFlags(), fusion: false, signupGrant: false }) };
    });
    const { landingFaq, signupGrantShown } = await import('./landing-faq-pick');
    const { pricingSentence } = await import('./feature-pricing');
    expect(landingFaq('faq-13')).toEqual([]);
    expect(landingFaq('faq-2')).toHaveLength(1);
    expect(signupGrantShown()).toBe(false);
    expect(pricingSentence('content', [])).toBe('免费开始；会员价格见价格页。');
  });
});
