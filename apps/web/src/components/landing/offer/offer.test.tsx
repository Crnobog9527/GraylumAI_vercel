import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANDING_FEATURES, resolveLandingFlags, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { FinalAction } from './FinalAction';
import { HowItWorks } from './HowItWorks';
import { OfferFaq } from './OfferFaq';
import { OfferHero } from './OfferHero';
import { PriceSection } from './PriceSection';
import { VoiceWall } from './VoiceWall';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const CATALOG = [plan('pro', 29, 279), plan('gold', 69, 621)];
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

function renderPage(flags: LandingFlags) {
  const data = buildLandingPageData(flags, CATALOG, { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 37 } });
  return renderToStaticMarkup(createElement(Fragment, null,
    createElement(OfferHero),
    createElement(VoiceWall, { notes: data.notes }),
    createElement(HowItWorks, { promise: data.promise, timeline: data.timeline }),
    createElement(PriceSection, { pricing: data.pricing, rows: data.compareRows, risk: data.risk, showResult: data.showResult,
      founderSeats: data.founderSeats, membershipHref: '/profile?tab=subscription' }),
    createElement(OfferFaq, { groups: data.faqGroups }),
    createElement(FinalAction, { showStack: data.showStack, founderSeats: data.founderSeats }),
  ));
}

describe('landing page sections', () => {
  it('has one H1, the fixed section order and the jump target for "看它怎么工作"', () => {
    const html = renderPage(ALL_ON);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('你的 AI 自媒体陪跑教练');
    expect(html).toContain('href="#how-it-works"');
    const order = ['你的 AI 自媒体陪跑教练', '他们抱怨的 vs 教练怎么做', 'AI 教练怎么接手你的运营', '先聊后买', '常见问题', '现在有两条路']
      .map(text => html.indexOf(text));
    expect(order.every(position => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('id="how-it-works"');
  });

  it('renders the full offer with server prices and founder seats when everything is accepted', () => {
    const html = renderPage(ALL_ON);
    expect(html).toContain('Graylum AI 自媒体陪跑教练：$29/月起。');
    expect(html).toContain('前 50 位创始会员，招满为止');
    expect(html).toContain('还剩 37 个名额');
    expect(html).toContain('首月 $49，之后每月 $69 自动续费，可随时取消');
    expect(html).toContain('译自英文');
    expect(html).toContain('HeyOrca 2024 年社媒经理调查');
  });

  it('leaves out unaccepted promises in the default state', () => {
    const html = renderPage(resolveLandingFlags({}));
    expect(html).not.toContain('一键发');
    expect(html).not.toContain('每周告诉你哪条有效');
    expect(html).not.toContain('排程工具');
    expect(html).not.toContain('创始会员');
    expect(html).not.toContain('模型 A');
    // The page never states income, follower growth or durations.
    expect(html).not.toMatch(/月入|涨粉\d|\d+\s*(分钟|小时内出)/);
  });
});
