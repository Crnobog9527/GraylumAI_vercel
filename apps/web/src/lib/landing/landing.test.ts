import { describe, expect, it } from 'vitest';
import { LANDING_FAQ, faqAnswerText } from './landing-faq';
import { LANDING_FEATURES, resolveLandingFlags, type LandingFlags } from './landing-flags';
import { buildLandingPageData } from './landing-page-data';
import { buildLandingPricing, landingOfferList } from './landing-pricing';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const CATALOG = [plan('free', 0, 0), plan('pro', 29, 279), plan('gold', 69, 621)];
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
// Only the positioning chat live: used to check that switching a capability off hides its blocks.
const CORE_ONLY = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, key === 'coach'])) as LandingFlags;

describe('landing flags', () => {
  it('shows the finished product by default, except sample reports that are not generated yet (Owner 2026-10-13)', () => {
    const flags = resolveLandingFlags({});
    for (const [key, feature] of Object.entries(LANDING_FEATURES)) {
      expect(flags[key as keyof LandingFlags]).toBe(feature.show);
    }
    expect(Object.entries(flags).filter(([, on]) => !on).map(([key]) => key)).toEqual(['sampleReports']);
  });

  it('lets staging and previews show blocks that are off, never the indexed production page', () => {
    expect(resolveLandingFlags({ LANDING_PREVIEW_FEATURES: 'sampleReports' }).sampleReports).toBe(true);
    expect(resolveLandingFlags({ LANDING_PREVIEW_FEATURES: 'all' }).sampleReports).toBe(true);
    expect(resolveLandingFlags({ LANDING_PREVIEW_FEATURES: 'all', SITE_INDEXING: 'public' }).sampleReports).toBe(false);
  });
});

describe('landing FAQ', () => {
  it('keeps the 16 final questions in three groups (4 / 6 / 6)', () => {
    expect(LANDING_FAQ.map(group => [group.title, group.items.length])).toEqual([
      ['关于教练', 4], ['关于我适不适合', 6], ['关于付费和账号', 6],
    ]);
    expect(LANDING_FAQ.flatMap(group => group.items).map(item => item.id))
      .toEqual(Array.from({ length: 16 }, (_, index) => `faq-${index + 1}`));
  });

  it('gives the JSON-LD the same text the page shows', () => {
    const data = buildLandingPageData(ALL_ON, CATALOG);
    const shown = data.faqGroups.flatMap(group => group.items);
    expect(data.faqItems).toEqual(shown.map(item => ({ question: item.question, answer: item.answer.join('\n') })));
    expect(faqAnswerText(shown[7])).toContain('\n1. 把你现有的定位资料上传到账号资料库，再连上你的账号。\n');
  });
});

describe('landing price cards', () => {
  const offers = { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 37 } };

  it('matches the final card wording when the server provides every offer', () => {
    const pricing = buildLandingPricing(CATALOG, offers);
    const [pro, gold, founder] = pricing.cards;
    expect(pricing.yearlyBadge).toBe('最高省 40%');
    expect(pro.quotes.monthly).toMatchObject({ price: '$29', per: '/月', strike: null, renewal: '每月自动续费 $29，可随时取消' });
    expect(pro.quotes.yearly).toMatchObject({ price: '$279', strike: '$348', saving: '比按月付省 $69 · 相当于 $23.25/月' });
    expect(gold.quotes.monthly).toMatchObject({
      price: '$49', per: ' 首月', strike: '$69', tag: '新用户首月', renewal: '首月 $49，之后每月 $69 自动续费，可随时取消',
    });
    expect(gold.quotes.yearly).toMatchObject({ price: '$621', strike: '$828', saving: '比按月付省 $207 · 相当于 $51.75/月' });
    expect(founder.quotes.monthly).toBeNull();
    expect(founder.missingNote.monthly).toBe('（创始会员只有年付）');
    expect(founder.quotes.yearly).toMatchObject({
      price: '$496', strike: '$828', tag: '创始会员 · 终身 6 折', saving: '比按月付省 $332 · 相当于 $41.33/月',
      renewal: '首年 $496，之后每年按当时 Gold 月付×12 的 6 折续费，可随时取消',
    });
  });

  it('never invents the first-month or founder offer without a server answer', () => {
    const pricing = buildLandingPricing(CATALOG);
    expect(pricing.cards.map(card => card.key)).toEqual(['pro', 'gold']);
    expect(pricing.cards[1].quotes.monthly).toMatchObject({ price: '$69', strike: null, renewal: '每月自动续费 $69，可随时取消' });
    expect(pricing.yearlyBadge).toBe('最高省 25%');
    expect(pricing.founderOpen).toBe(false);
  });

  it('drops the founder card once the seats are gone', () => {
    const pricing = buildLandingPricing(CATALOG, { founder: { price: 496, total: 50, available: 0 } });
    expect(pricing.cards.map(card => card.key)).toEqual(['pro', 'gold']);
    expect(pricing.yearlyBadge).toBe('最高省 25%');
  });

  it('shows nothing it cannot read', () => {
    expect(buildLandingPricing([]).cards).toEqual([]);
    expect(buildLandingPricing([plan('gold', 69, 621), plan('gold', 59, 600)]).cards).toEqual([]);
  });

  it('lists the same prices for the SoftwareApplication JSON-LD', () => {
    expect(landingOfferList(buildLandingPricing(CATALOG))).toEqual([
      { name: '免费', price: 0 }, { name: 'Pro 月付', price: 29 }, { name: 'Pro 年付', price: 279 },
      { name: 'Gold 月付', price: 69 }, { name: 'Gold 年付', price: 621 },
    ]);
  });
});

describe('landing page data', () => {
  it('hides every block whose capability is switched off', () => {
    const data = buildLandingPageData(CORE_ONLY, CATALOG);
    expect(data.notes.map(note => note.id)).toEqual(['p2', 'p5']);
    // FAQ 2, 4, 6, 14; FAQ 11 also promises the sign-up credits, so it goes with signupGrant.
    expect(data.faqItems.map(item => item.question)).toEqual([
      LANDING_FAQ[0].items[1].question, LANDING_FAQ[0].items[3].question, LANDING_FAQ[1].items[1].question,
      LANDING_FAQ[2].items[3].question,
    ]);
    expect(data.compareRows.map(row => row.sourceId)).toEqual(['consultant']);
    expect(data.promise.map(part => part.text).join('')).not.toContain('不用自己想选题');
    expect(data.timeline).toHaveLength(1);
    expect(data.showStack).toBe(false);
    expect(data.showResult).toEqual({ pro: false, gold: false });
  });

  it('shows the finished-product page by default, still without invented founder or first-month prices', () => {
    const data = buildLandingPageData(resolveLandingFlags({}), CATALOG);
    expect(data.notes).toHaveLength(7);
    expect(data.faqItems).toHaveLength(16);
    expect(data.compareRows).toHaveLength(4);
    expect(data.heroNote).toContain('注册送 500 积分');
    // No public price answer yet: no founder card, no seats, Gold monthly stays at the catalog price.
    expect(data.pricing.cards.map(card => card.key)).toEqual(['pro', 'gold']);
    expect(data.founderSeats).toBeNull();
    expect(data.pricing.cards[1].quotes.monthly?.price).toBe('$69');
  });

  it('shows the full page when everything is on', () => {
    const data = buildLandingPageData(ALL_ON, CATALOG, { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 12 } });
    expect(data.notes).toHaveLength(7);
    expect(data.faqItems).toHaveLength(16);
    expect(data.compareRows).toHaveLength(4);
    expect(data.promise.map(part => part.text).join('')).toBe(
      '你不用再分心研究运营技术，不用自己想选题，也不用再为怎么变现发愁。发了内容以后，也不用自己看数据：它每周告诉你哪条有效、下周怎么调。'
      + '你也不用研究哪个模型更强、提示词怎么写。这些都已经打包进你的 AI 教练。拍摄、出镜、录音这些要你本人来，其余交给它。',
    );
    expect(data.founderSeats).toBe(12);
    expect(data.showStack).toBe(true);
    expect(data.heroNote).toBe('免费注册，不用绑卡。注册送 500 积分。聊出来的内容随时能看、能导出，不会收回。');
    expect(data.finalNote).toBe('不用绑卡 · 注册送 500 积分 · 聊出来的内容不会收回');
    expect(data.risk).toHaveLength(4);
  });

  it('keeps the founder offer hidden while its switch is off, even if the server sends it', () => {
    const flags = { ...ALL_ON, founder: false };
    const data = buildLandingPageData(flags, CATALOG, { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 12 } });
    expect(data.pricing.cards.map(card => card.key)).toEqual(['pro', 'gold']);
    expect(data.founderSeats).toBeNull();
    expect(data.faqItems.map(item => item.question)).not.toContain('为什么创始会员只有 50 个名额？');
  });
});
