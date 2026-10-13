/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PaywallPlanSource } from '@/components/paywall/paywallPlans';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from './landing-copy';
import { LANDING_FAQ, faqAnswerText } from './landing-faq';
import { FLOW_STEPS } from './landing-flow';
import { SAMPLE_REPORTS } from './landing-samples';
import { allOn, visibleItems, type LandingFlags } from './landing-flags';
import { buildLandingPricing, landingOfferList, type LandingOffers } from './landing-pricing';

// Home page wording approved by the Owner on 2026-10-13 (SEO_GEO_SPEC section 3.3). The public host
// serves this page at "/", so that is its canonical address. The description's data-review claim
// needs its owning task accepted before launch (MASTER_PLAN section 2.1, 2026-10-13).
export const HOME_TITLE = 'AI 自媒体陪跑教练｜从零开始，教你做好自媒体';
export const HOME_DESCRIPTION =
  '从制定账号策略到分析内容表现，Graylum 会持续复盘数据、找出增长机会、给出具体优化建议。不懂运营的新手，也能用专业的方法做好自媒体。';

/**
 * Everything the landing page shows, after hiding switched-off capabilities. Pure, so the page, its
 * JSON-LD and the tests read the same filtered content.
 */
export function buildLandingPageData(flags: LandingFlags, plans: readonly PaywallPlanSource[], offers: LandingOffers = {}) {
  const pricing = buildLandingPricing(plans, flags.founder ? offers : { goldFirstMonth: offers.goldFirstMonth });
  // The founder FAQ promises a price, 50 seats and a live seat count: only while the server says the offer is on sale.
  const faqFlags = { ...flags, founder: flags.founder && pricing.founderOpen };
  const faqGroups = LANDING_FAQ
    .map(group => ({ ...group, items: visibleItems(faqFlags, group.items) }))
    .filter(group => group.items.length > 0);
  const founderSeats = pricing.founderOpen && offers.founder ? offers.founder.available : null;

  return {
    heroNote: visibleItems(flags, HERO.note).map(part => part.text).join(''),
    finalNote: visibleItems(flags, FINAL_ACTION.note).map(part => part.text).join(' · '),
    notes: visibleItems(flags, VOICE_WALL.notes),
    promise: visibleItems(flags, HOW_IT_WORKS.promise),
    flowSteps: visibleItems(flags, FLOW_STEPS),
    sampleReports: flags.sampleReports ? SAMPLE_REPORTS : [],
    timeline: visibleItems(flags, HOW_IT_WORKS.timeline),
    compareRows: visibleItems(flags, PRICE_COMPARE.rows),
    risk: visibleItems(flags, RISK_REVERSAL.points),
    pricing,
    showResult: Object.fromEntries(pricing.cards.map(card => [card.key, allOn(flags, card.result.needs)])),
    founderSeats,
    showStack: allOn(flags, FINAL_ACTION.stack.needs),
    faqGroups,
    faqItems: faqGroups.flatMap(group => group.items.map(item => ({ question: item.question, answer: faqAnswerText(item) }))),
    offerList: landingOfferList(pricing),
  };
}
