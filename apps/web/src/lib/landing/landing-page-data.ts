/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PaywallPlanSource } from '@/components/paywall/paywallPlans';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from './landing-copy';
import { LANDING_FAQ, faqAnswerText } from './landing-faq';
import { FLOW_STEPS } from './landing-flow';
import { SAMPLE_REPORTS } from './landing-samples';
import { allOn, visibleItems, type LandingFlags } from './landing-flags';
import { buildLandingPricing, landingOfferList, type LandingOffers } from './landing-pricing';

// Home page wording approved by the Owner on 2026-10-12 (SEO_GEO_SPEC section 3.3). The public host
// serves this page at "/", so that is its canonical address.
export const HOME_TITLE = 'Graylum – AI 自媒体工具：定位、选题、写内容的 AI 自媒体陪跑教练';
export const HOME_DESCRIPTION =
  'Graylum 是你的 AI 自媒体陪跑教练：帮你找准账号定位、决定每周发什么、写出能直接发的内容。免费和教练聊聊，一步步把账号做起来。';

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
