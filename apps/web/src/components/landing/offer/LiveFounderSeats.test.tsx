import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';

const useQuery = vi.hoisted(() => vi.fn());
vi.mock('@/trpc/client', () => ({ trpc: { settings: { getPublicOffers: { useQuery } } } }));

import { FinalAction } from './FinalAction';
import { FounderSeatsProvider } from './LiveFounderSeats';
import { OfferFaq } from './OfferFaq';
import { PriceSection } from './PriceSection';
import { purchaseHref } from './PriceCards';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)],
  { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 37 } });

function render() {
  return renderToStaticMarkup(createElement(FounderSeatsProvider, { initial: data.founderSeats, children: createElement(Fragment, null,
    createElement(PriceSection, { pricing: data.pricing, rows: data.compareRows, risk: data.risk, showResult: data.showResult,
      founderSeats: data.founderSeats, membershipHref: '/profile?tab=subscription' }),
    createElement(OfferFaq, { groups: data.faqGroups }),
    createElement(FinalAction, { showStack: data.showStack, founderSeats: data.founderSeats, note: data.finalNote })) }));
}

beforeEach(() => useQuery.mockReset());

describe('live founder seats on the hourly pre-rendered landing page', () => {
  it('shows the pre-rendered count until the browser has a live answer, or when that answer has no founder offer', () => {
    useQuery.mockReturnValue({ data: undefined });
    expect(render().match(/还剩 37 个名额/g)).toHaveLength(2);
    useQuery.mockReturnValue({ data: { goldFirstMonth: 49, founder: null } });
    expect(render().match(/还剩 37 个名额/g)).toHaveLength(2);
    expect(useQuery).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: true, retry: false }));
  });

  it('replaces the count with the live one', () => {
    useQuery.mockReturnValue({ data: { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 3 } } });
    const html = render();
    expect(html.match(/还剩 3 个名额/g)).toHaveLength(2);
    expect(html).not.toContain('还剩 37 个名额');
    expect(html).toContain('data-testid="landing-plan-founder"');
    expect(html).toContain('最高省 40%');
    // Monthly is the default tab: each card links to its own plan and cycle on the membership page.
    expect(html).toContain('href="/profile?tab=subscription&amp;buy=gold&amp;cycle=monthly"');
    expect(html).toContain('href="/profile?tab=subscription&amp;buy=pro&amp;cycle=monthly"');
    expect(html).toContain('创始会员和普通 Gold 年付差在哪？');
  });

  it('removes the founder line, the closing seat line and the founder card once the live count is 0', () => {
    useQuery.mockReturnValue({ data: { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 0 } } });
    const html = render();
    expect(html).not.toContain('前 50 位创始会员');
    expect(html).not.toContain('个名额');
    expect(html).not.toContain('data-testid="landing-plan-founder"');
    expect(html).toContain('data-testid="landing-plan-gold"');
    // The yearly badge falls back to the best non-founder saving, and the founder FAQ entries leave too.
    expect(html).toContain('最高省 25%');
    expect(html).not.toContain('最高省 40%');
    expect(html).not.toContain('创始会员和普通 Gold 年付差在哪？');
    expect(html).not.toContain('为什么创始会员只有 50 个名额？');
    expect(html).toContain('常见问题');
  });
});

describe('purchase links from the landing cards', () => {
  it('names the plan and cycle, with founder as Gold yearly', () => {
    expect(purchaseHref('/profile?tab=subscription', 'gold', 'monthly')).toBe('/profile?tab=subscription&buy=gold&cycle=monthly');
    expect(purchaseHref('/profile?tab=subscription', 'pro', 'yearly')).toBe('/profile?tab=subscription&buy=pro&cycle=yearly');
    expect(purchaseHref('/profile?tab=subscription', 'founder', 'yearly')).toBe('/profile?tab=subscription&buy=gold&cycle=yearly');
    expect(purchaseHref('/profile', 'pro', 'monthly')).toBe('/profile?buy=pro&cycle=monthly');
  });
});
