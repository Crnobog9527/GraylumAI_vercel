import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANDING_FEATURES, resolveLandingFlags, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { FinalAction } from './FinalAction';
import { FlowSteps } from './FlowSteps';
import { SampleReports } from './SampleReports';
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
const CORE_ONLY = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, key === 'coach'])) as LandingFlags;

function renderPage(flags: LandingFlags) {
  const data = buildLandingPageData(flags, CATALOG, { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 37 } });
  return renderToStaticMarkup(createElement(Fragment, null,
    createElement(OfferHero, { note: data.heroNote }),
    createElement(VoiceWall, { notes: data.notes }),
    createElement(HowItWorks, { promise: data.promise, timeline: data.timeline },
      createElement(FlowSteps, { steps: data.flowSteps }), createElement(SampleReports, { reports: data.sampleReports })),
    createElement(PriceSection, { pricing: data.pricing, rows: data.compareRows, risk: data.risk, showResult: data.showResult,
      founderSeats: data.founderSeats, membershipHref: '/profile?tab=subscription' }),
    createElement(OfferFaq, { groups: data.faqGroups }),
    createElement(FinalAction, { showStack: data.showStack, founderSeats: data.founderSeats, note: data.finalNote }),
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

  it('shows the built walk-through steps in order by default (Owner 2026-10-17: unbuilt ones off)', () => {
    const html = renderPage(resolveLandingFlags({}));
    const titles = ['和教练聊', '教练说真话', '找对标', '出报告', '多模型评审团（Gold）'];
    for (const unbuilt of ['资料库，它记得你', '写内容', '发出去', '看复盘']) expect(html).not.toContain(`>${unbuilt}<`);
    const positions = titles.map(title => html.indexOf(`>${title}<`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html.match(/为什么不是正确的废话/g)).toHaveLength(5);
  });

  it('hides the library step when the coach is off, since its note promises the coach answering', () => {
    const data = buildLandingPageData({ ...ALL_ON, coach: false }, CATALOG);
    expect(data.flowSteps.map(step => step.id)).not.toContain('step-library');
  });

  it('hides walk-through steps whose capability is off, numbered without gaps', () => {
    const html = renderPage(CORE_ONLY);
    expect(html).toContain('>和教练聊<');
    expect(html).toContain('>教练说真话<');
    expect(html).not.toContain('>找对标<');
    expect(html).not.toContain('模型 A');
    expect(html.match(/为什么不是正确的废话/g)).toHaveLength(2);
    expect(html).not.toContain('不同人群的样例报告');
  });

  it('renders the sample-report tabs with the four audiences and three fixed parts when switched on', () => {
    const html = renderPage(ALL_ON);
    expect(html).toContain('不同人群的样例报告');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toContain('有一门专业、想做知识付费的上班族');
    expect(html).toContain('想给店里引流的小店老板');
    for (const part of ['一句话定位和为什么', '第一个 30 天计划', '变现路线']) expect(html).toContain(part);
    expect(html).toContain('>示例<');
  });

  it('renders the full offer with server prices and founder seats when everything is on', () => {
    const html = renderPage(ALL_ON);
    expect(html).toContain('Graylum AI 自媒体陪跑教练：$29/月起。');
    expect(html).toContain('前 50 位创始会员，招满为止');
    expect(html).toContain('还剩 37 个名额');
    expect(html).toContain('首月 $49，之后每月 $69 自动续费，可随时取消');
    expect(html).toContain('译自英文');
    expect(html).toContain('HeyOrca 2024 年社媒经理调查');
  });

  it('leaves out the promises of capabilities that are switched off', () => {
    const html = renderPage(CORE_ONLY);
    expect(html).not.toContain('一键发');
    expect(html).not.toContain('每周告诉你哪条有效');
    expect(html).not.toContain('排程工具');
    expect(html).not.toContain('创始会员');
    expect(html).not.toContain('模型 A');
    // The page says "free trial" and never how many credits come with sign-up (Owner 2026-10-14).
    expect(html).not.toContain('500 积分');
    expect(html).not.toContain('不会收回');
    // With the sign-up grant off there is no free trial to offer, so the notes fall back to "无需绑卡".
    expect(html).not.toContain('免费试用');
    expect(html).toContain('无需绑卡');
    // The page never states income, follower growth or durations.
    expect(html).not.toMatch(/月入|涨粉\d|\d+\s*(分钟|小时内出)/);
  });
});
